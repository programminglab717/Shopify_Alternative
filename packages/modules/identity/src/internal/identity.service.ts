import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  MFA_REQUIRED_ROLES,
  REAUTHENTICATION_WINDOW_MS,
  isStaffRole,
  type StaffRole,
} from '@hatti/api';
import {
  SecretBox,
  base32Encode,
  otpauthUri,
  secretToken,
  sha256,
  verifyTotp,
} from '@hatti/crypto';
import type { Db, Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId, toPublicId, tryFromPublicId } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import type { RateLimit, RateLimiter } from '@hatti/ratelimit';
import { metrics, type Counter } from '@opentelemetry/api';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { AuthError, invalidCredentials, unauthenticated } from './errors.js';
import {
  PASSKEY_LIMITS,
  challengeOf,
  userHandleOf,
  type PasskeyInfo,
  type PasskeySettings,
} from './passkeys.js';
import {
  PASSWORD_MAX_LENGTH,
  hashPassword,
  needsRehash,
  noBreachCheck,
  passwordProblem,
  verifyAgainstDummy,
  verifyPassword,
  type BreachedPasswordChecker,
} from './passwords.js';
import {
  authEvents,
  memberships,
  mfaChallenges,
  passkeyChallenges,
  passkeys,
  passwordCredentials,
  recoveryCodes,
  sessions,
  shops,
  totpCredentials,
  users,
} from './schema.js';
import {
  SHOP_LIMITS,
  ShopEvents,
  handleFrom,
  handleProblem,
  type ShopOpenedPayload,
} from './shops.js';

export const TOKEN_PREFIX = { access: 'hsa_', refresh: 'hsr_', challenge: 'hmc_' } as const;

const tokenPattern = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
export const ACCESS_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.access);
const REFRESH_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.refresh);
const CHALLENGE_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.challenge);

export const LIFETIMES = {
  /** Sent with every request, so kept short. */
  accessTokenMs: 15 * 60_000,
  /** Absolute; refreshing never extends it. */
  sessionMs: 30 * 24 * 3_600_000,
  /** A session unused for this long must sign in again. */
  idleMs: 7 * 24 * 3_600_000,
  mfaChallengeMs: 5 * 60_000,
  /** For answering a passkey's challenge, to add one or to sign in with one alone. */
  passkeyChallengeMs: 5 * 60_000,
  /** Two requests refreshing at once are a client race, not theft. */
  refreshReuseGraceMs: 10_000,
} as const;

const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

export const RATE_LIMITS = {
  signInByEmail: { name: 'auth:sign-in:email', limit: 10, windowMs: 15 * 60_000 },
  signInByIp: { name: 'auth:sign-in:ip', limit: 100, windowMs: 15 * 60_000 },
  signUpByIp: { name: 'auth:sign-up:ip', limit: 10, windowMs: 60 * 60_000 },
  secondFactorByUser: { name: 'auth:second-factor:user', limit: 10, windowMs: 15 * 60_000 },
  reauthenticateByUser: { name: 'auth:reauthenticate:user', limit: 10, windowMs: 15 * 60_000 },
  openShopByUser: { name: 'auth:open-shop:user', limit: 10, windowMs: 24 * 60 * 60_000 },
} as const satisfies Record<string, RateLimit>;

export interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IdentityServiceOptions {
  /** The identity login (hatti_identity). */
  db: Db;
  /** Encrypts TOTP secrets. */
  secretBox: SecretBox;
  /** Without one, nothing is rate limited: only acceptable in tests. */
  rateLimiter?: RateLimiter | null;
  breachedPasswords?: BreachedPasswordChecker;
  /** Rate limit checks fail open; this hears about it. */
  onRateLimitError?: (error: unknown) => void;
  /** Name shown in authenticator apps. */
  issuer?: string;
  /** Where staff sign in with passkeys (ADR-100); without it, they can't. */
  passkeys?: PasskeySettings | null;
  now?: () => Date;
}

export interface UserProfile {
  /** Public id, e.g. usr_… */
  id: string;
  email: string;
  name: string;
  phone: string | null;
  mfaEnabled: boolean;
}

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  /** The session's absolute end. */
  refreshTokenExpiresAt: Date;
  session: SessionSummary;
}

/** A session as its own tokens describe it. */
export interface SessionSummary {
  id: string;
  mfaVerified: boolean;
  /**
   * When its user last proved who they are: signing in, or re-authenticating since. Sensitive
   * actions need it to be within `REAUTHENTICATION_WINDOW_MS` (ADR-103).
   */
  authenticatedAt: Date;
}

/**
 * What confirms who is at a session before a sensitive action (ADR-103): the account's second
 * factor where it has one, its password otherwise.
 */
export type ReauthenticationMethod = 'passkey' | 'totp' | 'password';

export interface Reauthentication {
  authenticatedAt: Date;
  /** Until when sensitive actions need no other confirmation. */
  sensitiveActionsUntil: Date;
}

/** What answers the second step of a sign-in after the password. */
export type SecondFactorMethod = 'passkey' | 'totp' | 'recovery_code';

export type SignInResult =
  | { status: 'signed_in'; user: UserProfile; tokens: SessionTokens }
  | {
      status: 'mfa_required';
      challengeToken: string;
      challengeExpiresAt: Date;
      /** What the user can answer it with: a passkey first, where they have one. */
      methods: SecondFactorMethod[];
      /** For `navigator.credentials.get()`, where a passkey of theirs can answer it. */
      passkeyOptions: PublicKeyCredentialRequestOptionsJSON | null;
    };

/** A caller of /auth endpoints, from its access token. */
export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
  mfaVerified: boolean;
  /** When its user last proved who they are (ADR-103). */
  authenticatedAt: Date;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  mfaVerified: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface ShopAccess {
  id: string;
  name: string;
  role: StaffRole;
  /** The role needs two-step verification before it can use the shop. */
  mfaRequired: boolean;
}

/** A shop the user just opened, with the handle its storefront took. */
export interface OpenedShop extends ShopAccess {
  handle: string;
}

type Executor = Pick<Db, 'insert' | 'select' | 'update' | 'delete'>;

type PasskeyRow = typeof passkeys.$inferSelect;

/** What a passkey's challenge is for: adding one, signing in with one alone, or re-authenticating. */
type PasskeyPurpose = 'register' | 'sign_in' | 'reauthenticate';

function toPasskeyInfo(row: PasskeyRow): PasskeyInfo {
  return {
    id: toPublicId('passkey', row.id),
    name: row.name,
    multiDevice: row.multiDevice,
    backedUp: row.backedUp,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

const invalidPasskey = () =>
  new AuthError('INVALID_PASSKEY', 401, 'That passkey could not sign you in');

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/** Pakistani numbers in any local format, or any number in international (+…) format. */
function normalizePhone(input: string): string | null {
  const pakistani = parsePkMobile(input);
  if (pakistani) return pakistani.e164;
  const compact = input.replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

/**
 * Behind a proxy the client address comes from X-Forwarded-For, which anyone can fill in. Store
 * only well-formed addresses.
 */
export const ipOf = (client: ClientInfo): string | null =>
  client.ip && isIP(client.ip) !== 0 ? client.ip : null;
export const userAgentOf = (client: ClientInfo): string | null =>
  client.userAgent?.slice(0, 512) ?? null;

const totpContext = (userId: string) => `totp:${userId}`;
const recoveryCodeHash = (code: string) => sha256(code.replace(/[\s-]/g, '').toUpperCase());

function newRecoveryCode(): string {
  const code = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function toProfile(
  row: { id: string; email: string; name: string; phoneE164: string | null },
  mfaEnabled: boolean,
): UserProfile {
  return {
    id: toPublicId('user', row.id),
    email: row.email,
    name: row.name,
    phone: row.phoneE164,
    mfaEnabled,
  };
}

/**
 * Staff sign-up and sign-in (a passkey; or a password, then a passkey or TOTP when they have one),
 * sessions with rotating refresh tokens, and two-step verification set-up. See
 * docs/engineering/conventions.md#staff-sign-in.
 */
export class IdentityService {
  private readonly db: Db;
  private readonly secretBox: SecretBox;
  private readonly rateLimiter: RateLimiter | null;
  private readonly breaches: BreachedPasswordChecker;
  private readonly issuer: string;
  private readonly passkeys: PasskeySettings | null;
  private readonly now: () => Date;
  /** Sign-in attempts by step and outcome; a jump in failures means credential stuffing. */
  private readonly signInAttempts: Counter;

  constructor(private readonly options: IdentityServiceOptions) {
    this.db = options.db;
    this.secretBox = options.secretBox;
    this.rateLimiter = options.rateLimiter ?? null;
    this.breaches = options.breachedPasswords ?? noBreachCheck;
    this.issuer = options.issuer ?? 'Hatti';
    this.passkeys = options.passkeys ?? null;
    this.now = options.now ?? (() => new Date());
    this.signInAttempts = metrics.getMeter('hatti.identity').createCounter('hatti.auth.sign_ins', {
      description: 'Sign-in attempts by step (password, second_factor, passkey) and outcome',
    });
  }

  async signUp(
    input: { email: string; password: string; name: string; phone?: string | null },
    client: ClientInfo,
  ): Promise<{ userId: string; user: UserProfile; tokens: SessionTokens }> {
    await this.limit(RATE_LIMITS.signUpByIp, client.ip);
    const fields: Record<string, string> = {};
    const email = normalizeEmail(input.email);
    if (!email) fields.email = 'Enter a valid email address';
    const name = input.name.trim();
    if (name.length === 0 || name.length > 255) fields.name = 'Enter your name';
    let phone: string | null = null;
    if (input.phone?.trim()) {
      phone = normalizePhone(input.phone);
      if (!phone) fields.phone = 'Enter a mobile number like 0300 1234567 or +92 300 1234567';
    }
    if (email) {
      const problem = await passwordProblem(input.password, { email }, this.breaches);
      if (problem) fields.password = problem;
    }
    if (!email || Object.keys(fields).length > 0) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', { fields });
    }

    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const userId = newId();
      const [user] = await tx
        .insert(users)
        .values({ id: userId, email, name, phoneE164: phone })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!user) {
        throw new AuthError(
          'EMAIL_TAKEN',
          409,
          'An account with this email exists. Sign in instead',
          {
            fields: { email: 'Already registered' },
          },
        );
      }
      await tx.insert(passwordCredentials).values({ userId, hash: passwordHash });
      await this.recordEvent(tx, userId, 'sign_up', client);
      const tokens = await this.createSession(tx, userId, false, client);
      return { userId, user: toProfile(user, false), tokens };
    });
  }

  signIn(input: { email: string; password: string }, client: ClientInfo): Promise<SignInResult> {
    return this.counted('password', () => this.passwordStep(input, client));
  }

  private async passwordStep(
    input: { email: string; password: string },
    client: ClientInfo,
  ): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    await this.limit(RATE_LIMITS.signInByEmail, email);

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        phoneE164: users.phoneE164,
        status: users.status,
        hash: passwordCredentials.hash,
        totpConfirmedAt: totpCredentials.confirmedAt,
      })
      .from(users)
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .leftJoin(totpCredentials, eq(totpCredentials.userId, users.id))
      .where(eq(users.email, email));

    const password = input.password.slice(0, PASSWORD_MAX_LENGTH + 1);
    const valid =
      row?.hash && password.length <= PASSWORD_MAX_LENGTH
        ? await verifyPassword(row.hash, password)
        : await verifyAgainstDummy(password);
    if (!row?.hash || !valid || row.status !== 'active') {
      await this.recordEvent(this.db, row?.id ?? null, 'sign_in_failed', client);
      throw invalidCredentials();
    }
    await this.resetLimit(RATE_LIMITS.signInByEmail, email);
    if (needsRehash(row.hash)) {
      await this.db
        .update(passwordCredentials)
        .set({ hash: await hashPassword(password), updatedAt: this.now() })
        .where(eq(passwordCredentials.userId, row.id));
    }

    const keys = await this.passkeysOf(this.db, row.id);
    if (row.totpConfirmedAt || keys.length > 0) {
      const challengeToken = secretToken(TOKEN_PREFIX.challenge);
      const challengeExpiresAt = new Date(this.now().getTime() + LIFETIMES.mfaChallengeMs);
      // A passkey of theirs answers it too, where passkeys are served (ADR-100).
      const passkeyOptions =
        this.passkeys && keys.length > 0
          ? await generateAuthenticationOptions({
              rpID: this.passkeys.rpId,
              allowCredentials: keys.map((key) => ({
                id: key.credentialId,
                transports: key.transports,
              })),
              userVerification: 'required',
              timeout: LIFETIMES.mfaChallengeMs,
            })
          : null;
      await this.db.insert(mfaChallenges).values({
        id: newId(),
        userId: row.id,
        tokenHash: sha256(challengeToken),
        expiresAt: challengeExpiresAt,
        ip: ipOf(client),
        userAgent: userAgentOf(client),
        passkeyChallenge: passkeyOptions?.challenge ?? null,
      });
      const methods: SecondFactorMethod[] = [
        ...(passkeyOptions ? (['passkey'] as const) : []),
        ...(row.totpConfirmedAt ? (['totp'] as const) : []),
        'recovery_code',
      ];
      return {
        status: 'mfa_required',
        challengeToken,
        challengeExpiresAt,
        methods,
        passkeyOptions,
      };
    }

    const tokens = await this.db.transaction(async (tx) => {
      await this.recordEvent(tx, row.id, 'sign_in', client);
      return this.createSession(tx, row.id, false, client);
    });
    return { status: 'signed_in', user: toProfile(row, false), tokens };
  }

  /** Second step of sign-in: a TOTP code or a recovery code, or a passkey's response. */
  completeSignIn(
    input: {
      challengeToken: string;
      code?: string | null;
      passkey?: AuthenticationResponseJSON | null;
    },
    client: ClientInfo,
  ): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    return this.counted('second_factor', () => this.secondFactorStep(input, client));
  }

  private async secondFactorStep(
    input: {
      challengeToken: string;
      code?: string | null;
      passkey?: AuthenticationResponseJSON | null;
    },
    client: ClientInfo,
  ): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    if (!CHALLENGE_TOKEN_PATTERN.test(input.challengeToken)) throw this.challengeExpired();
    const outcome = await this.db.transaction(async (tx) => {
      const now = this.now();
      const [challenge] = await tx
        .select()
        .from(mfaChallenges)
        .where(eq(mfaChallenges.tokenHash, sha256(input.challengeToken)))
        .for('update');
      if (
        !challenge ||
        challenge.usedAt ||
        challenge.expiresAt <= now ||
        challenge.attempts >= MAX_CHALLENGE_ATTEMPTS
      ) {
        return { kind: 'expired' } as const;
      }
      await this.limit(RATE_LIMITS.secondFactorByUser, challenge.userId);
      const factor = input.passkey
        ? await this.checkPasskeyFactor(tx, challenge, input.passkey)
        : await this.checkSecondFactor(tx, challenge.userId, input.code ?? '');
      if (!factor) {
        await tx
          .update(mfaChallenges)
          .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
          .where(eq(mfaChallenges.id, challenge.id));
        await this.recordEvent(tx, challenge.userId, 'second_factor_failed', client);
        return input.passkey
          ? ({ kind: 'wrong_passkey' } as const)
          : ({ kind: 'wrong_code' } as const);
      }
      await tx.update(mfaChallenges).set({ usedAt: now }).where(eq(mfaChallenges.id, challenge.id));
      await this.recordEvent(
        tx,
        challenge.userId,
        factor === 'recovery_code'
          ? 'sign_in_with_recovery_code'
          : factor === 'passkey'
            ? 'sign_in_with_passkey'
            : 'sign_in',
        client,
      );
      const tokens = await this.createSession(tx, challenge.userId, true, client);
      return { kind: 'ok', tokens, user: await this.profileOf(tx, challenge.userId) } as const;
    });
    if (outcome.kind === 'expired') throw this.challengeExpired();
    if (outcome.kind === 'wrong_passkey') throw invalidPasskey();
    if (outcome.kind === 'wrong_code') {
      throw new AuthError(
        'INVALID_CODE',
        401,
        'That code is not right. Check your authenticator app',
      );
    }
    return { user: outcome.user, tokens: outcome.tokens };
  }

  /**
   * What to give `navigator.credentials.get()` to sign in with a passkey alone (ADR-100): any of
   * the platform's passkeys the browser holds, the user choosing one.
   */
  async passkeySignInOptions(client: ClientInfo): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const settings = this.passkeySettings();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    const options = await generateAuthenticationOptions({
      rpID: settings.rpId,
      userVerification: 'required',
      timeout: LIFETIMES.passkeyChallengeMs,
    });
    await this.keepPasskeyChallenge(options.challenge, 'sign_in', null);
    return options;
  }

  /**
   * Signs in with a passkey alone, answering {@link passkeySignInOptions}: the passkey says whose
   * it is, and its user verification (a fingerprint, a face or a PIN) is the second factor, so
   * the session has passed one.
   */
  signInWithPasskey(
    input: { response: AuthenticationResponseJSON },
    client: ClientInfo,
  ): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    return this.counted('passkey', () => this.passkeyStep(input, client));
  }

  private async passkeyStep(
    input: { response: AuthenticationResponseJSON },
    client: ClientInfo,
  ): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    this.passkeySettings();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    const challenge = challengeOf(input.response);
    const outcome = await this.db.transaction(async (tx) => {
      const expected = await this.takePasskeyChallenge(tx, challenge, 'sign_in', null);
      if (!expected) return { kind: 'expired' } as const;
      const key = await this.passkeyByCredential(tx, input.response.id);
      const signedIn =
        key !== null &&
        key.userStatus === 'active' &&
        (await this.checkPasskey(tx, key, input.response, expected));
      if (!key || !signedIn) {
        await this.recordEvent(tx, key?.userId ?? null, 'sign_in_failed', client);
        return { kind: 'refused' } as const;
      }
      await this.recordEvent(tx, key.userId, 'sign_in_with_passkey', client);
      const tokens = await this.createSession(tx, key.userId, true, client);
      return { kind: 'ok', tokens, user: await this.profileOf(tx, key.userId) } as const;
    });
    if (outcome.kind === 'expired') throw this.challengeExpired();
    if (outcome.kind === 'refused') throw invalidPasskey();
    return { user: outcome.user, tokens: outcome.tokens };
  }

  /**
   * Swaps a refresh token for new tokens. Each refresh token works once: presenting a used one
   * means it was copied, so the whole session ends.
   */
  async refresh(refreshToken: string, client: ClientInfo): Promise<SessionTokens> {
    const invalid = new AuthError('INVALID_REFRESH_TOKEN', 401, 'Sign in again: the session ended');
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw invalid;
    const presented = sha256(refreshToken);
    const outcome = await this.db.transaction(async (tx) => {
      const now = this.now();
      const [current] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.refreshTokenHash, presented))
        .for('update');
      if (current) {
        const idle = current.lastUsedAt.getTime() + LIFETIMES.idleMs <= now.getTime();
        if (current.revokedAt || current.expiresAt <= now || idle)
          return { kind: 'ended' } as const;
        const accessToken = secretToken(TOKEN_PREFIX.access);
        const nextRefreshToken = secretToken(TOKEN_PREFIX.refresh);
        const accessTokenExpiresAt = this.accessExpiry(now, current.expiresAt);
        await tx
          .update(sessions)
          .set({
            accessTokenHash: sha256(accessToken),
            accessExpiresAt: accessTokenExpiresAt,
            refreshTokenHash: sha256(nextRefreshToken),
            previousRefreshTokenHash: presented,
            refreshedAt: now,
            lastUsedAt: now,
            ip: ipOf(client) ?? current.ip,
            userAgent: userAgentOf(client) ?? current.userAgent,
          })
          .where(eq(sessions.id, current.id));
        const tokens: SessionTokens = {
          accessToken,
          accessTokenExpiresAt,
          refreshToken: nextRefreshToken,
          refreshTokenExpiresAt: current.expiresAt,
          session: {
            id: toPublicId('session', current.id),
            mfaVerified: current.mfaVerifiedAt !== null,
            authenticatedAt: current.authenticatedAt,
          },
        };
        return { kind: 'ok', tokens } as const;
      }

      const [previous] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.previousRefreshTokenHash, presented))
        .for('update');
      if (!previous || previous.revokedAt) return { kind: 'ended' } as const;
      const sinceRotation = now.getTime() - (previous.refreshedAt?.getTime() ?? 0);
      if (sinceRotation < LIFETIMES.refreshReuseGraceMs) return { kind: 'race' } as const;
      await tx
        .update(sessions)
        .set({ revokedAt: now, revokedReason: 'refresh_token_reuse' })
        .where(eq(sessions.id, previous.id));
      await this.recordEvent(tx, previous.userId, 'refresh_token_reuse', client);
      return { kind: 'reused' } as const;
    });
    switch (outcome.kind) {
      case 'ok':
        return outcome.tokens;
      case 'race':
        throw new AuthError(
          'REFRESH_TOKEN_ALREADY_USED',
          409,
          'This refresh token was just used. Use the tokens from that response',
        );
      case 'reused':
        throw new AuthError(
          'SESSION_REVOKED',
          401,
          'This session was ended because an old refresh token was used again. Sign in again',
        );
      case 'ended':
        throw invalid;
    }
  }

  /** Resolves an access token for /auth endpoints. */
  async authenticate(accessToken: string | undefined): Promise<AuthenticatedSession> {
    if (!accessToken || !ACCESS_TOKEN_PATTERN.test(accessToken)) throw unauthenticated();
    const now = this.now();
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        mfaVerifiedAt: sessions.mfaVerifiedAt,
        authenticatedAt: sessions.authenticatedAt,
      })
      .from(sessions)
      .innerJoin(users, and(eq(users.id, sessions.userId), eq(users.status, 'active')))
      .where(
        and(
          eq(sessions.accessTokenHash, sha256(accessToken)),
          isNull(sessions.revokedAt),
          gt(sessions.accessExpiresAt, now),
          gt(sessions.expiresAt, now),
        ),
      );
    if (!row) throw unauthenticated();
    return {
      userId: row.userId,
      sessionId: row.sessionId,
      mfaVerified: row.mfaVerifiedAt !== null,
      authenticatedAt: row.authenticatedAt,
    };
  }

  async signOut(auth: AuthenticatedSession, client: ClientInfo): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: this.now(), revokedReason: 'sign_out' })
        .where(and(eq(sessions.id, auth.sessionId), isNull(sessions.revokedAt)));
      await this.recordEvent(tx, auth.userId, 'sign_out', client);
    });
  }

  /** Signed-in devices, newest first, for the "where you're signed in" page. */
  async listSessions(auth: AuthenticatedSession): Promise<SessionInfo[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, auth.userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, this.now()),
        ),
      )
      // UUIDv7 ids break ties between sessions created in the same millisecond.
      .orderBy(desc(sessions.createdAt), desc(sessions.id));
    return rows.map((row) => ({
      id: toPublicId('session', row.id),
      current: row.id === auth.sessionId,
      mfaVerified: row.mfaVerifiedAt !== null,
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  /** Signs out one of the user's sessions, e.g. a lost phone. */
  async revokeSession(
    auth: AuthenticatedSession,
    publicSessionId: string,
    client: ClientInfo,
  ): Promise<void> {
    const sessionId = tryFromPublicId(publicSessionId, 'session');
    const revoked = sessionId
      ? await this.db
          .update(sessions)
          .set({ revokedAt: this.now(), revokedReason: 'revoked_by_user' })
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.userId, auth.userId),
              isNull(sessions.revokedAt),
            ),
          )
          .returning({ id: sessions.id })
      : [];
    if (revoked.length === 0) throw new AuthError('NOT_FOUND', 404, 'Session not found');
    await this.recordEvent(this.db, auth.userId, 'session_revoked', client);
  }

  /**
   * Opens a shop of the signed-in user's own, whose owner they become (ONB-01, ADR-145): its name,
   * and the handle naming its storefront on the platform's domain, made from the name when none
   * is given and numbered when another shop has it. Its currency and time zone are Pakistan's
   * (ONB-10). The worker publishes its storefront as it hears the shop opened. A user owns five
   * shops at most.
   */
  async openShop(
    auth: AuthenticatedSession,
    input: { name: string; handle?: string | null },
    client: ClientInfo,
  ): Promise<OpenedShop> {
    await this.limit(RATE_LIMITS.openShopByUser, auth.userId);
    const name = input.name.replace(/\p{Cc}/gu, '').trim();
    const asked = input.handle?.trim().toLowerCase() || null;
    const fields: Record<string, string> = {};
    if (name.length === 0 || name.length > SHOP_LIMITS.name) {
      fields.name = `Name the shop, in ${SHOP_LIMITS.name} characters or fewer`;
    }
    const problem = asked === null ? null : handleProblem(asked);
    if (problem) fields.handle = problem;
    if (Object.keys(fields).length > 0) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', { fields });
    }
    return this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.userId, auth.userId), eq(memberships.role, 'owner')));
      if ((owned?.count ?? 0) >= SHOP_LIMITS.ownedShops) {
        throw new AuthError(
          'TOO_MANY_SHOPS',
          422,
          `An account owns ${SHOP_LIMITS.ownedShops} shops at most`,
        );
      }
      const shopId = newId();
      const handle = await this.#insertShop(tx, shopId, name, asked ?? handleFrom(name), {
        numbered: asked === null,
      });
      await tx.insert(memberships).values({ userId: auth.userId, shopId, role: 'owner' });
      await appendEvent<ShopOpenedPayload>(tx, shopId, {
        type: ShopEvents.ShopOpened,
        aggregateType: 'shop',
        aggregateId: shopId,
        payload: { handle },
      });
      await this.recordEvent(tx, auth.userId, 'shop_opened', client);
      return {
        id: toPublicId('shop', shopId),
        name,
        handle,
        role: 'owner',
        mfaRequired: MFA_REQUIRED_ROLES.has('owner'),
      };
    });
  }

  /**
   * Adds the shop under `handle`, or, `numbered`, the first of `handle-2`, `handle-3` … no other
   * shop has; the handle it took.
   */
  async #insertShop(
    tx: Tx,
    shopId: string,
    name: string,
    handle: string,
    options: { numbered: boolean },
  ): Promise<string> {
    // The identity login inserts these columns alone; the others take the table's defaults.
    const insert = async (candidate: string) =>
      (
        await tx.execute(sql`
          INSERT INTO control.shops (id, name, handle) VALUES (${shopId}, ${name}, ${candidate})
              ON CONFLICT (handle) DO NOTHING
          RETURNING handle`)
      ).rows.length > 0;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      const candidate = `${handle.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (await insert(candidate)) return candidate;
      if (!options.numbered) break;
    }
    if (options.numbered) {
      // Twenty taken: a random suffix, as unlikely to be taken as a shop's ID.
      const candidate = `${handle.slice(0, 31).replace(/-+$/, '')}-${randomBytes(4).toString('hex')}`;
      if (await insert(candidate)) return candidate;
    }
    throw new AuthError('HANDLE_TAKEN', 409, 'Another shop has this handle', {
      fields: { handle: 'Taken by another shop' },
    });
  }

  async me(auth: AuthenticatedSession): Promise<{
    user: UserProfile;
    session: SessionSummary;
    shops: ShopAccess[];
  }> {
    const user = await this.profileOf(this.db, auth.userId);
    const rows = await this.db
      .select({ shopId: memberships.shopId, role: memberships.role, name: shops.name })
      .from(memberships)
      .innerJoin(shops, and(eq(shops.id, memberships.shopId), eq(shops.status, 'active')))
      .where(and(eq(memberships.userId, auth.userId), eq(memberships.status, 'active')))
      .orderBy(asc(shops.name));
    return {
      user,
      session: {
        id: toPublicId('session', auth.sessionId),
        mfaVerified: auth.mfaVerified,
        authenticatedAt: auth.authenticatedAt,
      },
      shops: rows.flatMap((row) =>
        isStaffRole(row.role)
          ? [
              {
                id: toPublicId('shop', row.shopId),
                name: row.name,
                role: row.role,
                mfaRequired: MFA_REQUIRED_ROLES.has(row.role),
              },
            ]
          : [],
      ),
    };
  }

  /**
   * Starts authenticator-app set-up, from a session whose user proved who they are lately
   * (ADR-103). Replacing an existing authenticator, or adding one beside a passkey, needs a
   * session that already passed a second factor, so a stolen password alone cannot swap in the
   * thief's app.
   */
  async setUpTotp(auth: AuthenticatedSession): Promise<{ secret: string; otpauthUri: string }> {
    this.mustHaveAuthenticatedRecently(auth);
    const factors = await this.factorsOf(this.db, auth.userId);
    if (factors.totp && !auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        'Sign in with your current authenticator app before replacing it',
      );
    }
    if (factors.passkeys.length > 0 && !auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        'Sign in with your passkey before adding an authenticator app',
      );
    }
    const secret = randomBytes(20);
    const pending = this.secretBox.encrypt(secret, totpContext(auth.userId));
    await this.db
      .insert(totpCredentials)
      .values({ userId: auth.userId, pendingSecretEncrypted: pending })
      .onConflictDoUpdate({
        target: totpCredentials.userId,
        set: { pendingSecretEncrypted: pending },
      });
    const user = await this.profileOf(this.db, auth.userId);
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri({ secret, issuer: this.issuer, account: user.email }),
    };
  }

  /**
   * Finishes set-up with a code from the app. Marks this session as verified and returns fresh
   * recovery codes, which are shown once and stored only as hashes.
   */
  async confirmTotp(
    auth: AuthenticatedSession,
    code: string,
    client: ClientInfo,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.limit(RATE_LIMITS.secondFactorByUser, auth.userId);
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const [credential] = await tx
        .select()
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, auth.userId))
        .for('update');
      if (!credential?.pendingSecretEncrypted) {
        throw new AuthError('TOTP_NOT_SET_UP', 409, 'Start authenticator set-up first');
      }
      const secret = this.secretBox.decrypt(
        credential.pendingSecretEncrypted,
        totpContext(auth.userId),
      );
      const step = verifyTotp(secret, code.replace(/\s/g, ''), { timeMs: now.getTime() });
      if (step === null) {
        throw new AuthError(
          'INVALID_CODE',
          422,
          'That code is not right. Check the time on your phone',
        );
      }
      await tx
        .update(totpCredentials)
        .set({
          secretEncrypted: credential.pendingSecretEncrypted,
          pendingSecretEncrypted: null,
          confirmedAt: now,
          lastUsedStep: step,
        })
        .where(eq(totpCredentials.userId, auth.userId));
      await tx.update(sessions).set({ mfaVerifiedAt: now }).where(eq(sessions.id, auth.sessionId));
      const codes = await this.newRecoveryCodes(tx, auth.userId);
      await this.recordEvent(tx, auth.userId, 'two_step_enabled', client);
      return { recoveryCodes: codes };
    });
  }

  /**
   * What to give `navigator.credentials.create()` for a new passkey (ADR-100): one the device
   * keeps with the account's user handle, verifying its user, and none it holds already. Its user
   * must have proved who they are lately (ADR-103); once the account has a second factor, only a
   * session that passed one adds another.
   */
  async passkeyRegistrationOptions(
    auth: AuthenticatedSession,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const settings = this.passkeySettings();
    this.mustHaveAuthenticatedRecently(auth);
    const factors = await this.factorsOf(this.db, auth.userId);
    this.mayAddPasskey(auth, factors);
    const user = await this.profileOf(this.db, auth.userId);
    const options = await generateRegistrationOptions({
      rpName: settings.rpName,
      rpID: settings.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: userHandleOf(auth.userId),
      attestationType: 'none',
      excludeCredentials: factors.passkeys.map((key) => ({
        id: key.credentialId,
        transports: key.transports,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: LIFETIMES.passkeyChallengeMs,
    });
    await this.keepPasskeyChallenge(options.challenge, 'register', auth.userId);
    return options;
  }

  /**
   * Adds the passkey answering {@link passkeyRegistrationOptions}, named `name` ("Passkey" if
   * left out). The account's first second factor comes with recovery codes, shown once, for when
   * it is lost, as an authenticator app's does.
   */
  async registerPasskey(
    auth: AuthenticatedSession,
    input: { response: RegistrationResponseJSON; name?: string | null },
    client: ClientInfo,
  ): Promise<{ passkey: PasskeyInfo; recoveryCodes: string[] | null }> {
    const settings = this.passkeySettings();
    await this.limit(RATE_LIMITS.secondFactorByUser, auth.userId);
    const name = input.name?.trim() || 'Passkey';
    if (name.length > PASSKEY_LIMITS.name) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', {
        fields: { name: `At most ${PASSKEY_LIMITS.name} characters` },
      });
    }
    const challenge = challengeOf(input.response);
    const outcome = await this.db.transaction(async (tx) => {
      // One change to a user's second factors at a time.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.userId)).for('update');
      const factors = await this.factorsOf(tx, auth.userId);
      this.mayAddPasskey(auth, factors);
      const expected = await this.takePasskeyChallenge(tx, challenge, 'register', auth.userId);
      if (!expected) return { kind: 'expired' } as const;
      const verified = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: expected,
        expectedOrigin: settings.origins,
        expectedRPID: settings.rpId,
        requireUserVerification: true,
      }).catch(() => null);
      // Answered wrongly, its challenge is spent all the same.
      if (!verified?.verified) return { kind: 'invalid' } as const;
      const info = verified.registrationInfo;
      const [row] = await tx
        .insert(passkeys)
        .values({
          id: newId(),
          userId: auth.userId,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          multiDevice: info.credentialDeviceType === 'multiDevice',
          backedUp: info.credentialBackedUp,
          name,
          createdAt: this.now(),
        })
        .onConflictDoNothing({ target: passkeys.credentialId })
        .returning();
      if (!row) return { kind: 'taken' } as const;
      const first = !factors.totp && factors.passkeys.length === 0;
      const codes = first ? await this.newRecoveryCodes(tx, auth.userId) : null;
      await this.recordEvent(tx, auth.userId, 'passkey_added', client);
      return { kind: 'ok', passkey: toPasskeyInfo(row), recoveryCodes: codes } as const;
    });
    switch (outcome.kind) {
      case 'ok':
        return { passkey: outcome.passkey, recoveryCodes: outcome.recoveryCodes };
      case 'expired':
        throw new AuthError(
          'INVALID_CHALLENGE',
          409,
          "This passkey's set-up expired, or was answered already. Start again",
        );
      case 'invalid':
        throw new AuthError('INVALID_PASSKEY', 422, 'That passkey could not be added. Try again');
      case 'taken':
        throw new AuthError('PASSKEY_TAKEN', 409, 'This passkey is added already');
    }
  }

  /** The user's passkeys, the oldest first. */
  async listPasskeys(auth: AuthenticatedSession): Promise<PasskeyInfo[]> {
    return (await this.passkeysOf(this.db, auth.userId)).map(toPasskeyInfo);
  }

  /**
   * Removes one of the user's passkeys, such as a lost phone's, from a session that passed a
   * second factor and whose user proved who they are lately: a stolen session alone cannot take
   * away its owner's way in.
   */
  async removePasskey(
    auth: AuthenticatedSession,
    publicPasskeyId: string,
    client: ClientInfo,
  ): Promise<void> {
    this.mustHaveAuthenticatedRecently(auth);
    if (!auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        'Sign in with a passkey or your authenticator app before removing a passkey',
      );
    }
    const passkeyId = tryFromPublicId(publicPasskeyId, 'passkey');
    const removed = passkeyId
      ? await this.db
          .delete(passkeys)
          .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, auth.userId)))
          .returning({ id: passkeys.id })
      : [];
    if (removed.length === 0) throw new AuthError('NOT_FOUND', 404, 'Passkey not found');
    await this.recordEvent(this.db, auth.userId, 'passkey_removed', client);
  }

  /**
   * How the signed-in user confirms who they are before a sensitive action (ADR-103): with their
   * second factor where they have one, a passkey first, and with their password otherwise. A
   * passkey answers the options given here.
   */
  async reauthenticationOptions(auth: AuthenticatedSession): Promise<{
    methods: ReauthenticationMethod[];
    passkeyOptions: PublicKeyCredentialRequestOptionsJSON | null;
  }> {
    const factors = await this.factorsOf(this.db, auth.userId);
    const methods = this.reauthenticationMethods(factors);
    if (!methods.includes('passkey')) return { methods, passkeyOptions: null };
    const passkeyOptions = await generateAuthenticationOptions({
      rpID: this.passkeySettings().rpId,
      allowCredentials: factors.passkeys.map((key) => ({
        id: key.credentialId,
        transports: key.transports,
      })),
      userVerification: 'required',
      timeout: LIFETIMES.passkeyChallengeMs,
    });
    await this.keepPasskeyChallenge(passkeyOptions.challenge, 'reauthenticate', auth.userId);
    return { methods, passkeyOptions };
  }

  /**
   * Confirms who is at a session, for the sensitive actions of the next
   * `REAUTHENTICATION_WINDOW_MS` (ADR-103): a passkey's answer to
   * {@link reauthenticationOptions}, a code from their authenticator app, or their password where
   * the account has no second factor. A second factor marks the session as having passed one.
   */
  async reauthenticate(
    auth: AuthenticatedSession,
    input: {
      password?: string | null;
      code?: string | null;
      passkey?: AuthenticationResponseJSON | null;
    },
    client: ClientInfo,
  ): Promise<Reauthentication> {
    await this.limit(RATE_LIMITS.reauthenticateByUser, auth.userId);
    const method: ReauthenticationMethod = input.passkey
      ? 'passkey'
      : input.code
        ? 'totp'
        : 'password';
    const outcome = await this.db.transaction(async (tx) => {
      const methods = this.reauthenticationMethods(await this.factorsOf(tx, auth.userId));
      if (!methods.includes(method)) return { kind: 'other_method', methods } as const;
      const confirmed = input.passkey
        ? await this.checkOwnPasskey(tx, auth.userId, input.passkey)
        : method === 'totp'
          ? await this.checkTotp(tx, auth.userId, input.code ?? '')
          : await this.checkPassword(tx, auth.userId, input.password ?? '');
      if (!confirmed) {
        await this.recordEvent(tx, auth.userId, 'reauthentication_failed', client);
        return { kind: 'refused' } as const;
      }
      const now = this.now();
      await tx
        .update(sessions)
        .set(
          method === 'password'
            ? { authenticatedAt: now }
            : {
                authenticatedAt: now,
                mfaVerifiedAt: sql`coalesce(${sessions.mfaVerifiedAt}, ${now})`,
              },
        )
        .where(eq(sessions.id, auth.sessionId));
      await this.recordEvent(tx, auth.userId, 'reauthenticated', client);
      return { kind: 'ok', now } as const;
    });
    switch (outcome.kind) {
      case 'ok':
        return {
          authenticatedAt: outcome.now,
          sensitiveActionsUntil: new Date(outcome.now.getTime() + REAUTHENTICATION_WINDOW_MS),
        };
      case 'other_method':
        throw new AuthError(
          'INVALID_METHOD',
          422,
          outcome.methods.includes('password')
            ? 'Confirm with your password: your account has no passkey or authenticator app'
            : 'Confirm with your passkey or authenticator app: your account has one',
        );
      case 'refused':
        throw method === 'passkey'
          ? new AuthError('INVALID_PASSKEY', 422, 'That passkey could not confirm it is you')
          : method === 'totp'
            ? new AuthError(
                'INVALID_CODE',
                422,
                'That code is not right. Check your authenticator app',
              )
            : new AuthError('INVALID_PASSWORD', 422, 'That password is not right');
    }
  }

  /** Adds or changes a user's role in a shop. Invitations will build on this. */
  async grantMembership(input: { userId: string; shopId: string; role: StaffRole }): Promise<void> {
    await this.db
      .insert(memberships)
      .values(input)
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.shopId],
        set: { role: input.role, status: 'active', updatedAt: this.now() },
      });
  }

  /** Counts an attempt at one sign-in step by its outcome, e.g. mfa_required or rate_limited. */
  private async counted<T extends object>(
    step: 'password' | 'second_factor' | 'passkey',
    attempt: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await attempt();
      const outcome = 'status' in result ? String(result.status) : 'signed_in';
      this.signInAttempts.add(1, { step, outcome });
      return result;
    } catch (error) {
      const outcome = error instanceof AuthError ? error.code.toLowerCase() : 'error';
      this.signInAttempts.add(1, { step, outcome });
      throw error;
    }
  }

  private async checkSecondFactor(
    tx: Executor,
    userId: string,
    code: string,
  ): Promise<'totp' | 'recovery_code' | null> {
    const compact = code.replace(/[\s-]/g, '');
    if (/^\d{6}$/.test(compact)) return (await this.checkTotp(tx, userId, compact)) ? 'totp' : null;
    const used = await tx
      .update(recoveryCodes)
      .set({ usedAt: this.now() })
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, recoveryCodeHash(compact)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .returning({ userId: recoveryCodes.userId });
    return used.length > 0 ? 'recovery_code' : null;
  }

  /** A code from the user's authenticator app: right now, and never used before. */
  private async checkTotp(tx: Executor, userId: string, code: string): Promise<boolean> {
    const compact = code.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(compact)) return false;
    const [credential] = await tx
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId));
    if (!credential?.secretEncrypted) return false;
    const secret = this.secretBox.decrypt(credential.secretEncrypted, totpContext(userId));
    const step = verifyTotp(secret, compact, { timeMs: this.now().getTime() });
    // A code works once, even inside its 30-second window.
    if (step === null || (credential.lastUsedStep !== null && step <= credential.lastUsedStep)) {
      return false;
    }
    await tx
      .update(totpCredentials)
      .set({ lastUsedStep: step })
      .where(eq(totpCredentials.userId, userId));
    return true;
  }

  /** A passkey of the challenge's user answering the second step after their password. */
  private async checkPasskeyFactor(
    tx: Executor,
    challenge: { userId: string; passkeyChallenge: string | null },
    response: AuthenticationResponseJSON,
  ): Promise<'passkey' | null> {
    if (!this.passkeys || !challenge.passkeyChallenge) return null;
    const key = await this.passkeyByCredential(tx, response.id);
    if (!key || key.userId !== challenge.userId) return null;
    const signed = await this.checkPasskey(tx, key, response, challenge.passkeyChallenge);
    return signed ? 'passkey' : null;
  }

  /**
   * Whether `response` is `key`'s signature of `expected`, its user verified, from one of the
   * admin's origins, its counter moving on where it keeps one; if so, keeps what it says now.
   */
  private async checkPasskey(
    tx: Executor,
    key: PasskeyRow,
    response: AuthenticationResponseJSON,
    expected: string,
  ): Promise<boolean> {
    const settings = this.passkeySettings();
    // Where the authenticator says whose passkey it is, it must be its owner's.
    const handle = response.response.userHandle;
    if (handle && handle !== isoBase64URL.fromBuffer(userHandleOf(key.userId))) return false;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: settings.origins,
      expectedRPID: settings.rpId,
      credential: {
        id: key.credentialId,
        publicKey: new Uint8Array(key.publicKey),
        counter: key.counter,
        transports: key.transports,
      },
      requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified) return false;
    await tx
      .update(passkeys)
      .set({
        counter: result.authenticationInfo.newCounter,
        backedUp: result.authenticationInfo.credentialBackedUp,
        lastUsedAt: this.now(),
      })
      .where(eq(passkeys.id, key.id));
    return true;
  }

  private passkeySettings(): PasskeySettings {
    if (!this.passkeys) {
      throw new AuthError('PASSKEYS_UNAVAILABLE', 404, 'Passkeys are not available here');
    }
    return this.passkeys;
  }

  /** Keeps a challenge to answer once before it expires; expired ones go as new ones come. */
  private async keepPasskeyChallenge(
    challenge: string,
    purpose: PasskeyPurpose,
    userId: string | null,
  ): Promise<void> {
    const now = this.now();
    await this.db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, now));
    await this.db.insert(passkeyChallenges).values({
      id: newId(),
      challenge,
      purpose,
      userId,
      expiresAt: new Date(now.getTime() + LIFETIMES.passkeyChallengeMs),
      createdAt: now,
    });
  }

  /**
   * Spends the challenge a response answers, for `purpose` and `userId`'s (none while signing
   * in): it answers once, before it expires. Null when it can't.
   */
  private async takePasskeyChallenge(
    tx: Executor,
    challenge: string | null,
    purpose: PasskeyPurpose,
    userId: string | null,
  ): Promise<string | null> {
    if (!challenge) return null;
    const now = this.now();
    const [taken] = await tx
      .update(passkeyChallenges)
      .set({ usedAt: now })
      .where(
        and(
          eq(passkeyChallenges.challenge, challenge),
          eq(passkeyChallenges.purpose, purpose),
          userId === null ? isNull(passkeyChallenges.userId) : eq(passkeyChallenges.userId, userId),
          isNull(passkeyChallenges.usedAt),
          gt(passkeyChallenges.expiresAt, now),
        ),
      )
      .returning({ challenge: passkeyChallenges.challenge });
    return taken?.challenge ?? null;
  }

  private passkeysOf(executor: Executor, userId: string): Promise<PasskeyRow[]> {
    return executor
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
  }

  private async passkeyByCredential(
    executor: Executor,
    credentialId: string,
  ): Promise<(PasskeyRow & { userStatus: string }) | null> {
    const [row] = await executor
      .select({ key: passkeys, userStatus: users.status })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(eq(passkeys.credentialId, credentialId));
    return row ? { ...row.key, userStatus: row.userStatus } : null;
  }

  /** The user's second factors: an authenticator app, and passkeys. */
  private async factorsOf(
    executor: Executor,
    userId: string,
  ): Promise<{ totp: boolean; passkeys: PasskeyRow[] }> {
    const [totp] = await executor
      .select({ confirmedAt: totpCredentials.confirmedAt })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId));
    return { totp: Boolean(totp?.confirmedAt), passkeys: await this.passkeysOf(executor, userId) };
  }

  private mayAddPasskey(
    auth: AuthenticatedSession,
    factors: { totp: boolean; passkeys: PasskeyRow[] },
  ): void {
    if ((factors.totp || factors.passkeys.length > 0) && !auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        'Sign in with a passkey or your authenticator app before adding a passkey',
      );
    }
    if (factors.passkeys.length >= PASSKEY_LIMITS.perUser) {
      throw new AuthError(
        'TOO_MANY_PASSKEYS',
        409,
        `At most ${PASSKEY_LIMITS.perUser} passkeys: remove one first`,
      );
    }
  }

  /** Refuses a change to how the account signs in unless its user proved who they are lately. */
  private mustHaveAuthenticatedRecently(auth: AuthenticatedSession): void {
    if (this.now().getTime() - auth.authenticatedAt.getTime() >= REAUTHENTICATION_WINDOW_MS) {
      throw new AuthError(
        'REAUTHENTICATION_REQUIRED',
        403,
        'Confirm it is you first (POST /auth/reauthenticate), then try again',
      );
    }
  }

  /**
   * The account's strongest ways to confirm who they are: its second factors served here, or its
   * password where it has none.
   */
  private reauthenticationMethods(factors: {
    totp: boolean;
    passkeys: PasskeyRow[];
  }): ReauthenticationMethod[] {
    const methods: ReauthenticationMethod[] = [
      ...(this.passkeys && factors.passkeys.length > 0 ? (['passkey'] as const) : []),
      ...(factors.totp ? (['totp'] as const) : []),
    ];
    return methods.length > 0 ? methods : ['password'];
  }

  /** A passkey of the user's answering the challenge {@link reauthenticationOptions} gave them. */
  private async checkOwnPasskey(
    tx: Executor,
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    const expected = await this.takePasskeyChallenge(
      tx,
      challengeOf(response),
      'reauthenticate',
      userId,
    );
    if (!expected) return false;
    const key = await this.passkeyByCredential(tx, response.id);
    return key?.userId === userId && (await this.checkPasskey(tx, key, response, expected));
  }

  private async checkPassword(tx: Executor, userId: string, password: string): Promise<boolean> {
    const [row] = await tx
      .select({ hash: passwordCredentials.hash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId));
    const attempt = password.slice(0, PASSWORD_MAX_LENGTH + 1);
    if (!row || attempt.length > PASSWORD_MAX_LENGTH) {
      await verifyAgainstDummy(attempt);
      return false;
    }
    return verifyPassword(row.hash, attempt);
  }

  /** New recovery codes in place of any the user had, shown once and kept as hashes alone. */
  private async newRecoveryCodes(tx: Executor, userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx
      .insert(recoveryCodes)
      .values(codes.map((recoveryCode) => ({ userId, codeHash: recoveryCodeHash(recoveryCode) })));
    return codes;
  }

  private async createSession(
    tx: Executor,
    userId: string,
    mfaVerified: boolean,
    client: ClientInfo,
  ): Promise<SessionTokens> {
    const now = this.now();
    const id = newId();
    const accessToken = secretToken(TOKEN_PREFIX.access);
    const refreshToken = secretToken(TOKEN_PREFIX.refresh);
    const expiresAt = new Date(now.getTime() + LIFETIMES.sessionMs);
    const accessTokenExpiresAt = this.accessExpiry(now, expiresAt);
    await tx.insert(sessions).values({
      id,
      userId,
      accessTokenHash: sha256(accessToken),
      accessExpiresAt: accessTokenExpiresAt,
      refreshTokenHash: sha256(refreshToken),
      mfaVerifiedAt: mfaVerified ? now : null,
      authenticatedAt: now,
      userAgent: userAgentOf(client),
      ip: ipOf(client),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
    });
    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      session: { id: toPublicId('session', id), mfaVerified, authenticatedAt: now },
    };
  }

  private accessExpiry(now: Date, sessionExpiresAt: Date): Date {
    return new Date(Math.min(now.getTime() + LIFETIMES.accessTokenMs, sessionExpiresAt.getTime()));
  }

  private async profileOf(executor: Executor, userId: string): Promise<UserProfile> {
    const [row] = await executor
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        phoneE164: users.phoneE164,
        totpConfirmedAt: totpCredentials.confirmedAt,
        passkey: sql<boolean>`exists (select 1 from ${passkeys} where ${passkeys.userId} = ${users.id})`,
      })
      .from(users)
      .leftJoin(totpCredentials, eq(totpCredentials.userId, users.id))
      .where(eq(users.id, userId));
    if (!row) throw unauthenticated();
    return toProfile(row, row.totpConfirmedAt !== null || row.passkey);
  }

  private async recordEvent(
    executor: Executor,
    userId: string | null,
    kind: string,
    client: ClientInfo,
  ): Promise<void> {
    await executor.insert(authEvents).values({
      id: newId(),
      userId,
      kind,
      ip: ipOf(client),
      userAgent: userAgentOf(client),
      occurredAt: this.now(),
    });
  }

  private challengeExpired(): AuthError {
    return new AuthError('INVALID_CHALLENGE', 401, 'This sign-in attempt expired. Sign in again');
  }

  /** Counts an attempt. Rate limiting fails open: an outage of Redis must not lock everyone out. */
  private async limit(limit: RateLimit, subject: string | null | undefined): Promise<void> {
    if (!this.rateLimiter || !subject) return;
    let result;
    try {
      result = await this.rateLimiter.hit(limit, subject);
    } catch (error) {
      this.options.onRateLimitError?.(error);
      return;
    }
    if (!result.allowed) {
      throw new AuthError('RATE_LIMITED', 429, 'Too many attempts. Try again later', {
        retryAfterMs: result.retryAfterMs,
      });
    }
  }

  private async resetLimit(limit: RateLimit, subject: string): Promise<void> {
    await this.rateLimiter?.reset(limit, subject).catch((error: unknown) => {
      this.options.onRateLimitError?.(error);
    });
  }
}
