import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { SecretBox } from '@hatti/crypto';
import type { Redis } from 'ioredis';

/**
 * `hatti login` (DEV-08, ADR-990), as a device signs in to a TV app (RFC 8628): the terminal asks
 * for a login and is given a code to show and a link; the shop's owner or a manager opens the
 * link, signed in to the admin, checks the code is the one their terminal shows, and approves it
 * for one of their shops, read-only or to change things too; a custom app is made for the
 * terminal (ADR-395), and its token handed to the terminal the next time it asks, once. Nothing is
 * kept past ten minutes; the token only sealed, and only until it is fetched.
 */
export const CLI_LOGIN = {
  /** How long a login waits for its approval, and its token for the terminal. */
  seconds: 600,
  /** How often the terminal asks whether it is approved, in seconds. */
  interval: 5,
  /** The longest name a terminal gives itself. */
  device: 60,
} as const;

export const CLI_ACCESS = ['read', 'write'] as const;
export type CliAccess = (typeof CLI_ACCESS)[number];

/** The letters codes are made of: no vowels, so no words, and none misread as a digit. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE_LENGTH = 8;

/** A code as typed or linked, "bcdf ghjk" or "BCDF-GHJK", as it is kept: null for none. */
export function userCodeOf(text: string): string | null {
  const letters = text.toUpperCase().replace(/[\s-]/g, '');
  if (letters.length !== CODE_LENGTH) return null;
  if (![...letters].every((letter) => ALPHABET.includes(letter))) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function newUserCode(): string {
  const letters = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`;
}

/** The name a terminal gave itself, as the admin shows it: printable, short. */
export function deviceNameOf(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
          .replace(/[^\p{L}\p{N} ._@()-]/gu, '')
          .trim()
          .slice(0, CLI_LOGIN.device)
      : '';
  return text || 'a terminal';
}

/** Where logins wait: Valkey, shared by every API process; or memory, for one alone. */
export interface CliLoginStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Sets `key` only if it is not set: whether this caller set it. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Gets `key` and removes it, so that only one caller has it. */
  take(key: string): Promise<string | null>;
  delete(...keys: string[]): Promise<void>;
}

export class RedisCliLoginStore implements CliLoginStore {
  constructor(private readonly redis: Redis) {}

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number) {
    await this.redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
  }

  async claim(key: string, ttlMs: number) {
    return (await this.redis.set(key, '1', 'PX', Math.max(1, Math.ceil(ttlMs)), 'NX')) === 'OK';
  }

  take(key: string) {
    return this.redis.getdel(key);
  }

  async delete(...keys: string[]) {
    if (keys.length > 0) await this.redis.del(...keys);
  }
}

export class MemoryCliLoginStore implements CliLoginStore {
  readonly #values = new Map<string, { value: string; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string) {
    const kept = this.#values.get(key);
    if (!kept) return null;
    if (kept.until <= this.now()) {
      this.#values.delete(key);
      return null;
    }
    return kept.value;
  }

  async set(key: string, value: string, ttlMs: number) {
    this.#values.set(key, { value, until: this.now() + ttlMs });
  }

  async claim(key: string, ttlMs: number) {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, '1', ttlMs);
    return true;
  }

  async take(key: string) {
    const value = await this.get(key);
    this.#values.delete(key);
    return value;
  }

  async delete(...keys: string[]) {
    for (const key of keys) this.#values.delete(key);
  }
}

/** A login as the admin's approval page shows it. */
export interface CliLoginRequest {
  userCode: string;
  /** The name the terminal gave itself: its computer's, as a rule. */
  device: string;
  /** What the terminal asked for; the person approving chooses. */
  access: CliAccess;
  /** The address the terminal asked from, as the API saw it. */
  requestedFrom: string | null;
  expiresAt: Date;
  status: 'pending' | 'approved' | 'denied';
}

/** What the terminal is told when it asks. */
export type CliLoginPoll =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; accessToken: string; shopId: string; scopes: string[] };

/** What the terminal is given to begin with, named as RFC 8628 names it. */
export interface CliLoginBegun {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

interface Kept {
  device: string;
  access: CliAccess;
  requestedFrom: string | null;
  expiresAt: number;
  status: CliLoginRequest['status'];
  /** The token, sealed, once approved; with the shop and scopes it was given. */
  sealed?: string;
  shopId?: string;
  scopes?: string[];
}

const codeKey = (userCode: string) => `cli-login:code:${userCode}`;
const deviceKey = (deviceCode: string) =>
  `cli-login:device:${createHash('sha256').update(deviceCode).digest('base64url')}`;
const claimKey = (userCode: string) => `cli-login:claim:${userCode}`;
const sealedFor = (userCode: string) => `cli-login:${userCode}`;

/** The logins terminals are waiting on. */
export class CliLogins {
  constructor(
    private readonly store: CliLoginStore,
    private readonly box: SecretBox,
    /** The admin's origin, where the approval page is: https://admin.hatti.pk. */
    private readonly adminOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A login begun for a terminal: the codes it shows and keeps, and where to approve it. */
  async begin(asked: {
    device?: unknown;
    access?: unknown;
    requestedFrom?: string | null;
  }): Promise<CliLoginBegun> {
    const access: CliAccess = asked.access === 'read' ? 'read' : 'write';
    const ttl = CLI_LOGIN.seconds * 1000;
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      // A code in use is not given again while it waits; with 20⁸ codes, a clash is rare.
      if (!(await this.store.claim(`${codeKey(userCode)}:made`, ttl))) {
        if (attempt < 5) continue;
        throw new Error('No free login code: try again');
      }
      const deviceCode = randomBytes(32).toString('base64url');
      const kept: Kept = {
        device: deviceNameOf(asked.device),
        access,
        requestedFrom: asked.requestedFrom ?? null,
        expiresAt: this.now().getTime() + ttl,
        status: 'pending',
      };
      await this.store.set(codeKey(userCode), JSON.stringify(kept), ttl);
      await this.store.set(deviceKey(deviceCode), userCode, ttl);
      const verificationUrl = new URL('/cli-login', this.adminOrigin).toString();
      return {
        deviceCode,
        userCode,
        verificationUrl,
        verificationUrlComplete: `${verificationUrl}?code=${userCode}`,
        expiresIn: CLI_LOGIN.seconds,
        interval: CLI_LOGIN.interval,
      };
    }
  }

  /** The login a code names, for its approval page; null for none, or one past its time. */
  async describe(code: string): Promise<CliLoginRequest | null> {
    const userCode = userCodeOf(code);
    const kept = userCode ? await this.#kept(userCode) : null;
    if (!userCode || !kept) return null;
    return {
      userCode,
      device: kept.device,
      access: kept.access,
      requestedFrom: kept.requestedFrom,
      expiresAt: new Date(kept.expiresAt),
      status: kept.status,
    };
  }

  /**
   * Takes the login for one approval: false where it is gone, answered, or being approved by
   * another; so a login makes one app, however many approve it at once.
   */
  async claim(code: string): Promise<boolean> {
    const userCode = userCodeOf(code);
    const kept = userCode ? await this.#kept(userCode) : null;
    if (!userCode || kept?.status !== 'pending') return false;
    return this.store.claim(claimKey(userCode), kept.expiresAt - this.now().getTime());
  }

  /** The claimed login approved with the token made for it, for the terminal to fetch once. */
  async approve(
    code: string,
    granted: { accessToken: string; shopId: string; scopes: string[] },
  ): Promise<boolean> {
    const userCode = userCodeOf(code);
    const kept = userCode ? await this.#kept(userCode) : null;
    if (!userCode || kept?.status !== 'pending') return false;
    const approved: Kept = {
      ...kept,
      status: 'approved',
      sealed: this.box.encrypt(granted.accessToken, sealedFor(userCode)),
      shopId: granted.shopId,
      scopes: granted.scopes,
    };
    const left = kept.expiresAt - this.now().getTime();
    if (left <= 0) return false;
    await this.store.set(codeKey(userCode), JSON.stringify(approved), left);
    return true;
  }

  /** The login refused: its terminal is told so, and given nothing. */
  async deny(code: string): Promise<boolean> {
    const userCode = userCodeOf(code);
    const kept = userCode ? await this.#kept(userCode) : null;
    if (!userCode || kept?.status !== 'pending') return false;
    const left = kept.expiresAt - this.now().getTime();
    if (left <= 0) return false;
    await this.store.set(codeKey(userCode), JSON.stringify({ ...kept, status: 'denied' }), left);
    return true;
  }

  /** What the terminal holding `deviceCode` is told: an approved login's token is given once. */
  async poll(deviceCode: string): Promise<CliLoginPoll> {
    const device = deviceKey(deviceCode);
    const userCode = await this.store.get(device);
    const kept = userCode ? await this.#kept(userCode) : null;
    if (!userCode || !kept) return { status: 'expired' };
    if (kept.status === 'pending') return { status: 'pending' };
    if (kept.status === 'denied') {
      await this.store.delete(device, codeKey(userCode));
      return { status: 'denied' };
    }
    // Taken, so that a second ask, from here or a copy of the code, gets nothing.
    if ((await this.store.take(device)) === null) return { status: 'expired' };
    await this.store.delete(codeKey(userCode));
    return {
      status: 'approved',
      accessToken: this.box.decrypt(kept.sealed!, sealedFor(userCode)).toString('utf8'),
      shopId: kept.shopId!,
      scopes: kept.scopes ?? [],
    };
  }

  async #kept(userCode: string): Promise<Kept | null> {
    const text = await this.store.get(codeKey(userCode));
    if (!text) return null;
    const kept = JSON.parse(text) as Kept;
    return kept.expiresAt > this.now().getTime() ? kept : null;
  }
}
