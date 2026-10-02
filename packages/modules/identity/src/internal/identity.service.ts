import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AuthError, invalidCredentials, unauthenticated } from './errors.js';
import { GoogleIdTokens, type GoogleAccount, type GoogleSignInSettings } from './google.js';
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
  PHONE_CODE,
  maskPhone,
  newPhoneCode,
  phoneCodeDigest,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
  type PhoneCodeSender,
} from './phone-codes.js';
import {
  authEvents,
  googleAccounts,
  googleNonces,
  memberships,
  mfaChallenges,
  passkeyChallenges,
  passkeys,
  passwordCredentials,
  phoneCodes,
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

export const TOKEN_PREFIX = {
  access: 'hsa_',
  refresh: 'hsr_',
  challenge: 'hmc_',
  /** Opens an account with a number just proved (ADR-159). */
  signUp: 'hsu_',
} as const;

const tokenPattern = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
export const ACCESS_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.access);
const REFRESH_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.refresh);
const CHALLENGE_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.challenge);
const SIGN_UP_TOKEN_PATTERN = tokenPattern(TOKEN_PREFIX.signUp);

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
  /** For Google's sign-in to come back with the nonce it started with (ADR-164). */
  googleNonceMs: 10 * 60_000,
  /** Two requests refreshing at once are a client race, not theft. */
  refreshReuseGraceMs: 10_000,
} as const;

const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

export const RATE_LIMITS = {
  signInByEmail: { name: 'auth:sign-in:email', limit: 10, windowMs: 15 * 60_000 },
  signInByIp: { name: 'auth:sign-in:ip', limit: 100, windowMs: 15 * 60_000 },
  signUpByIp: { name: 'auth:sign-up:ip', limit: 10, windowMs: 60 * 60_000 },
  /** Codes asked for from one address, whatever the numbers (ADR-159). */
  phoneCodeByIp: { name: 'auth:phone-code:ip', limit: 30, windowMs: 60 * 60_000 },
  signInByPhone: { name: 'auth:sign-in:phone', limit: 10, windowMs: 15 * 60_000 },
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
  /** Sends the codes that prove numbers (ADR-159); without it, no one signs in by phone. */
  phoneCodes?: PhoneCodeSender | null;
  /** Hatti's client IDs at Google (ADR-164); without them, no one signs in with Google. */
  google?: GoogleSignInSettings | null;
  now?: () => Date;
}

export interface UserProfile {
  /** Public id, e.g. usr_… */
  id: string;
  /** Null for an account opened with a phone alone (ADR-159). */
  email: string | null;
  name: string;
  phone: string | null;
  /** Whether the number was proved with a code: then it signs the account in. */
  phoneVerified: boolean;
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

/**
 * What a code to a number signs in to (ADR-159): the account whose number it proves, as a
 * password does; or, for a number no account has proved, a token that opens one with it.
 */
export type PhoneSignInResult =
  | SignInResult
  | {
      status: 'sign_up_required';
      signUpToken: string;
      signUpTokenExpiresAt: Date;
      /** The number, masked. */
      phone: string;
    };

/**
 * What Google's ID token signs in to (ADR-164): the account its Google account is connected to, as
 * a password does; or a new account, opened with it, `signedUp` saying so.
 */
export type GoogleSignInResult = SignInResult & { signedUp: boolean };

/** The Google account that signs in to a user's own (ADR-164). */
export interface GoogleConnection {
  /** Its email at Google, as Google last gave it. */
  email: string;
  connectedAt: Date;
}

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

const wrongPhoneCode = () =>
  new AuthError('INVALID_CODE', 401, 'That code is not right. Check the last code sent to you');

const signUpExpired = () =>
  new AuthError('INVALID_SIGN_UP', 401, 'This sign-up expired. Ask for a new code');

const googleEmailUnconfirmed = () =>
  new AuthError(
    'GOOGLE_EMAIL_UNCONFIRMED',
    422,
    "Google has not confirmed this account's email. Confirm it with Google, or use another way",
  );

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
  row: {
    id: string;
    email: string | null;
    name: string;
    phoneE164: string | null;
    phoneVerifiedAt: Date | null;
  },
  mfaEnabled: boolean,
): UserProfile {
  return {
    id: toPublicId('user', row.id),
    email: row.email,
    name: row.name,
    phone: row.phoneE164,
    phoneVerified: row.phoneVerifiedAt !== null,
    mfaEnabled,
  };
}

/** What names an account in an authenticator app or a passkey: its email, else its number. */
const accountName = (user: UserProfile): string => user.email ?? user.phone ?? user.name;

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
  private readonly google: GoogleIdTokens | null;
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
    this.google = options.google ? new GoogleIdTokens(options.google) : null;
    this.now = options.now ?? (() => new Date());
    this.signInAttempts = metrics.getMeter('hatti.identity').createCounter('hatti.auth.sign_ins', {
      description:
        'Sign-in attempts by step (password, second_factor, passkey, phone, google) and outcome',
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
        phoneVerifiedAt: users.phoneVerifiedAt,
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

    return this.afterFirstFactor(row, client, 'sign_in');
  }

  /**
   * After a first factor, the password or a code to the account's number: a challenge for its
   * second factor where it has one, a session otherwise.
   */
  private async afterFirstFactor(
    row: {
      id: string;
      email: string | null;
      name: string;
      phoneE164: string | null;
      phoneVerifiedAt: Date | null;
      totpConfirmedAt: Date | null;
    },
    client: ClientInfo,
    event: string,
  ): Promise<SignInResult> {
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
      await this.recordEvent(tx, row.id, event, client);
      return this.createSession(tx, row.id, false, client);
    });
    return { status: 'signed_in', user: toProfile(row, false), tokens };
  }

  /**
   * Sends a code to a Pakistani mobile number, to sign in or open an account with it (ONB-01,
   * ADR-159): on WhatsApp unless SMS is asked for, or WhatsApp cannot deliver it. A number waits
   * 30 seconds between codes and is sent at most 5 an hour and 10 a day; the last sent alone works.
   */
  async sendPhoneCode(
    input: {
      phone: string;
      channel?: PhoneCodeChannel | null;
      language?: PhoneCodeLanguage | null;
    },
    client: ClientInfo,
  ): Promise<{ phone: string; channel: PhoneCodeChannel; expiresAt: Date; resendAfter: Date }> {
    const sender = this.phoneCodeSender();
    const phone = parsePkMobile(input.phone)?.e164;
    if (!phone) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', {
        fields: { phone: 'Enter a Pakistani mobile number like 0300 1234567' },
      });
    }
    await this.limit(RATE_LIMITS.phoneCodeByIp, client.ip);
    const now = this.now();
    const since = (ms: number) => new Date(now.getTime() - ms);
    const id = newId();
    const code = newPhoneCode();
    const asked = input.channel ?? 'whatsapp';
    const expiresAt = new Date(now.getTime() + PHONE_CODE.minutes * 60_000);
    // Codes are kept a month, to look into abuse; older ones go as new ones are sent.
    await this.db
      .delete(phoneCodes)
      .where(lt(phoneCodes.createdAt, since(PHONE_CODE.keepDays * 24 * 3_600_000)));
    await this.db.transaction(async (tx) => {
      // One request for a number at a time, so many at once are not each sent a code.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`phone_codes:${phone}`}, 0))`,
      );
      const [sent] = await tx
        .select({
          last: sql<Date | null>`max(${phoneCodes.createdAt})`.mapWith(phoneCodes.createdAt),
          hour: sql<number>`count(*) filter (where ${phoneCodes.createdAt} > ${since(3_600_000)})`.mapWith(
            Number,
          ),
          day: sql<number>`count(*)`.mapWith(Number),
        })
        .from(phoneCodes)
        .where(and(eq(phoneCodes.phone, phone), gt(phoneCodes.createdAt, since(24 * 3_600_000))));
      const wait = sent?.last
        ? sent.last.getTime() + PHONE_CODE.resendSeconds * 1000 - now.getTime()
        : 0;
      if (wait > 0) {
        throw new AuthError('TOO_SOON', 429, 'Wait a moment before asking for another code', {
          retryAfterMs: wait,
        });
      }
      if (
        (sent?.hour ?? 0) >= PHONE_CODE.perNumberHourly ||
        (sent?.day ?? 0) >= PHONE_CODE.perNumberDaily
      ) {
        throw new AuthError(
          'TOO_MANY_CODES',
          429,
          'Too many codes for this number. Try again later',
          {
            retryAfterMs: 3_600_000,
          },
        );
      }
      await tx.insert(phoneCodes).values({
        id,
        phone,
        channel: asked,
        codeHash: phoneCodeDigest(id, code),
        expiresAt,
        ip: ipOf(client),
        createdAt: now,
      });
    });
    const channel = await sender
      .send({ phone, code, channel: asked, language: input.language ?? 'en' })
      .catch(() => null);
    if (!channel) {
      // Not sent: it counts against nothing.
      await this.db.delete(phoneCodes).where(eq(phoneCodes.id, id));
      throw new AuthError(
        'CODE_NOT_SENT',
        503,
        'The code could not be sent just now. Try again, or ask for it by SMS',
      );
    }
    if (channel !== asked) {
      await this.db.update(phoneCodes).set({ channel }).where(eq(phoneCodes.id, id));
    }
    return {
      phone: maskPhone(phone),
      channel,
      expiresAt,
      resendAfter: new Date(now.getTime() + PHONE_CODE.resendSeconds * 1000),
    };
  }

  /**
   * Signs in with the last code sent to a number (ADR-159): to the account whose number it proves,
   * after its second factor where it has one, as a password does; or, for a number no account has
   * proved, a token that opens one with it for 15 minutes. Five tries at a code.
   */
  phoneSignIn(
    input: { phone: string; code: string },
    client: ClientInfo,
  ): Promise<PhoneSignInResult> {
    return this.counted('phone', () => this.phoneStep(input, client));
  }

  private async phoneStep(
    input: { phone: string; code: string },
    client: ClientInfo,
  ): Promise<PhoneSignInResult> {
    this.phoneCodeSender();
    const phone = parsePkMobile(input.phone)?.e164;
    if (!phone) throw wrongPhoneCode();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    await this.limit(RATE_LIMITS.signInByPhone, phone);
    const now = this.now();
    const checked = await this.db.transaction(async (tx) => {
      const [sent] = await tx
        .select()
        .from(phoneCodes)
        .where(eq(phoneCodes.phone, phone))
        .orderBy(desc(phoneCodes.createdAt))
        .limit(1)
        .for('update');
      if (!sent || sent.verifiedAt || sent.usedAt) return { kind: 'wrong' } as const;
      if (sent.attempts >= PHONE_CODE.attempts) return { kind: 'too_many' } as const;
      if (sent.expiresAt <= now) return { kind: 'expired' } as const;
      const typed = input.code.replace(/\D/g, '');
      const right =
        typed.length === PHONE_CODE.digits &&
        timingSafeEqual(phoneCodeDigest(sent.id, typed), sent.codeHash);
      if (!right) {
        await tx
          .update(phoneCodes)
          .set({ attempts: sql`${phoneCodes.attempts} + 1` })
          .where(eq(phoneCodes.id, sent.id));
        await this.recordEvent(tx, null, 'phone_code_failed', client);
        return { kind: sent.attempts + 1 >= PHONE_CODE.attempts ? 'too_many' : 'wrong' } as const;
      }
      const [account] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          phoneE164: users.phoneE164,
          phoneVerifiedAt: users.phoneVerifiedAt,
          status: users.status,
          totpConfirmedAt: totpCredentials.confirmedAt,
        })
        .from(users)
        .leftJoin(totpCredentials, eq(totpCredentials.userId, users.id))
        .where(and(eq(users.phoneE164, phone), isNotNull(users.phoneVerifiedAt)));
      if (account) {
        await tx
          .update(phoneCodes)
          .set({ verifiedAt: now, usedAt: now })
          .where(eq(phoneCodes.id, sent.id));
        return { kind: 'account', account } as const;
      }
      const signUpToken = secretToken(TOKEN_PREFIX.signUp);
      await tx
        .update(phoneCodes)
        .set({ verifiedAt: now, signUpTokenHash: sha256(signUpToken) })
        .where(eq(phoneCodes.id, sent.id));
      return { kind: 'new', signUpToken } as const;
    });
    switch (checked.kind) {
      case 'wrong':
        throw wrongPhoneCode();
      case 'expired':
        throw new AuthError('CODE_EXPIRED', 401, 'That code has expired. Ask for a new one');
      case 'too_many':
        throw new AuthError('TOO_MANY_ATTEMPTS', 429, 'Too many wrong codes. Ask for a new one');
      case 'account':
        if (checked.account.status !== 'active') {
          throw new AuthError('INVALID_CREDENTIALS', 401, 'This account cannot sign in');
        }
        await this.resetLimit(RATE_LIMITS.signInByPhone, phone);
        return this.afterFirstFactor(checked.account, client, 'sign_in_with_phone');
      case 'new':
        return {
          status: 'sign_up_required',
          signUpToken: checked.signUpToken,
          signUpTokenExpiresAt: new Date(now.getTime() + PHONE_CODE.signUpMinutes * 60_000),
          phone: maskPhone(phone),
        };
    }
  }

  /**
   * Opens an account with a number {@link phoneSignIn} proved (ADR-159): its owner's name, and an
   * email if they give one; signed in at once. From then on the number is the account's alone.
   */
  async phoneSignUp(
    input: { signUpToken: string; name: string; email?: string | null },
    client: ClientInfo,
  ): Promise<{ userId: string; user: UserProfile; tokens: SessionTokens }> {
    await this.limit(RATE_LIMITS.signUpByIp, client.ip);
    const fields: Record<string, string> = {};
    const name = input.name.trim();
    if (name.length === 0 || name.length > 255) fields.name = 'Enter your name';
    let email: string | null = null;
    if (input.email?.trim()) {
      email = normalizeEmail(input.email);
      if (!email) fields.email = 'Enter a valid email address';
    }
    if (Object.keys(fields).length > 0) {
      throw new AuthError('INVALID_INPUT', 422, 'Some details need fixing', { fields });
    }
    if (!SIGN_UP_TOKEN_PATTERN.test(input.signUpToken)) throw signUpExpired();
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const [proved] = await tx
        .select()
        .from(phoneCodes)
        .where(eq(phoneCodes.signUpTokenHash, sha256(input.signUpToken)))
        .for('update');
      if (
        !proved?.verifiedAt ||
        proved.usedAt ||
        proved.verifiedAt.getTime() + PHONE_CODE.signUpMinutes * 60_000 <= now.getTime()
      ) {
        throw signUpExpired();
      }
      const userId = newId();
      // Another account may have proved the number since, or have the email.
      const [user] = await tx
        .insert(users)
        .values({ id: userId, email, name, phoneE164: proved.phone, phoneVerifiedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!user) {
        const [taken] = email
          ? await tx.select({ id: users.id }).from(users).where(eq(users.email, email))
          : [];
        throw taken
          ? new AuthError(
              'EMAIL_TAKEN',
              409,
              'An account with this email exists. Sign in instead',
              {
                fields: { email: 'Already registered' },
              },
            )
          : new AuthError(
              'PHONE_TAKEN',
              409,
              'This number has an account already. Sign in with it instead',
            );
      }
      await tx.update(phoneCodes).set({ usedAt: now }).where(eq(phoneCodes.id, proved.id));
      await this.recordEvent(tx, userId, 'sign_up', client);
      const tokens = await this.createSession(tx, userId, false, client);
      return { userId, user: toProfile(user, false), tokens };
    });
  }

  /** The sender of phone codes, or an error where none is set up. */
  private phoneCodeSender(): PhoneCodeSender {
    if (!this.options.phoneCodes) {
      throw new AuthError(
        'PHONE_SIGN_IN_UNAVAILABLE',
        503,
        'Signing in by phone is not set up here. Sign in with your email',
      );
    }
    return this.options.phoneCodes;
  }

  /**
   * Starts signing in with Google, or connecting a Google account (ONB-01, ADR-164): the client
   * ID the admin's sign-in takes, and a nonce for Google to sign into its ID token, which answers
   * once in the next 10 minutes.
   */
  async googleOptions(
    client: ClientInfo,
  ): Promise<{ clientId: string; nonce: string; expiresAt: Date }> {
    const google = this.googleTokens();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    const now = this.now();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + LIFETIMES.googleNonceMs);
    await this.db.delete(googleNonces).where(lt(googleNonces.expiresAt, now));
    await this.db.insert(googleNonces).values({ nonce, expiresAt, createdAt: now });
    return { clientId: google.clientId, nonce, expiresAt };
  }

  /**
   * Signs in with Google's ID token (ADR-164), carrying a nonce from {@link googleOptions}: to the
   * account its Google account is connected to, after the account's second factor where it has
   * one, as a password does. A Google account connected to none opens an account at once, with
   * Google's name and the email Google confirmed, unless an account has that email: that one
   * signs in its own way first, and connects Google from there.
   */
  signInWithGoogle(input: { idToken: string }, client: ClientInfo): Promise<GoogleSignInResult> {
    return this.counted('google', () => this.googleStep(input, client));
  }

  private async googleStep(
    input: { idToken: string },
    client: ClientInfo,
  ): Promise<GoogleSignInResult> {
    const google = this.googleTokens();
    await this.limit(RATE_LIMITS.signInByIp, client.ip);
    const account = await this.checkGoogle(google, input.idToken, client);
    const email = account.email && normalizeEmail(account.email);
    const now = this.now();
    const outcome = await this.db.transaction(async (tx) => {
      if (!(await this.takeGoogleNonce(tx, account.nonce))) return { kind: 'expired' } as const;
      // One sign-in with a Google account at a time, so two at once open one account.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`google:${account.subject}`}, 0))`,
      );
      const [connected] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          phoneE164: users.phoneE164,
          phoneVerifiedAt: users.phoneVerifiedAt,
          status: users.status,
          totpConfirmedAt: totpCredentials.confirmedAt,
        })
        .from(googleAccounts)
        .innerJoin(users, eq(users.id, googleAccounts.userId))
        .leftJoin(totpCredentials, eq(totpCredentials.userId, users.id))
        .where(eq(googleAccounts.subject, account.subject));
      if (connected) {
        await tx
          .update(googleAccounts)
          .set({ ...(email ? { email } : {}), lastSignedInAt: now })
          .where(eq(googleAccounts.subject, account.subject));
        return { kind: 'account', account: connected } as const;
      }
      if (!email) return { kind: 'unconfirmed' } as const;
      const userId = newId();
      // An email alike never connects a Google account: whoever typed it may not own it.
      const [user] = await tx
        .insert(users)
        .values({
          id: userId,
          email,
          emailVerifiedAt: now,
          name: account.name ?? email.slice(0, email.indexOf('@')),
        })
        .onConflictDoNothing()
        .returning();
      if (!user) return { kind: 'email_taken' } as const;
      await tx
        .insert(googleAccounts)
        .values({ subject: account.subject, userId, email, createdAt: now, lastSignedInAt: now });
      await this.recordEvent(tx, userId, 'sign_up_with_google', client);
      const tokens = await this.createSession(tx, userId, false, client);
      return { kind: 'new', user: toProfile(user, false), tokens } as const;
    });
    switch (outcome.kind) {
      case 'expired':
        throw this.challengeExpired();
      case 'unconfirmed':
        throw googleEmailUnconfirmed();
      case 'email_taken':
        throw new AuthError(
          'GOOGLE_NOT_CONNECTED',
          409,
          'An account has this email. Sign in to it your usual way, then connect Google to it',
        );
      case 'account':
        if (outcome.account.status !== 'active') {
          throw new AuthError('INVALID_CREDENTIALS', 401, 'This account cannot sign in');
        }
        return {
          ...(await this.afterFirstFactor(outcome.account, client, 'sign_in_with_google')),
          signedUp: false,
        };
      case 'new':
        return { status: 'signed_in', user: outcome.user, tokens: outcome.tokens, signedUp: true };
    }
  }

  /**
   * Connects the Google account whose ID token is given to the signed-in user's own (ADR-164):
   * from then on it signs them in. Taken from a session whose user proved who they are lately,
   * after a second factor where the account has one. A Google account signs in to one account,
   * and an account has one.
   */
  async connectGoogle(
    auth: AuthenticatedSession,
    input: { idToken: string },
    client: ClientInfo,
  ): Promise<GoogleConnection> {
    const google = this.googleTokens();
    await this.mustHavePassedSecondFactor(auth, 'connecting Google');
    const account = await this.checkGoogle(google, input.idToken, client);
    const email = account.email && normalizeEmail(account.email);
    if (!email) throw googleEmailUnconfirmed();
    const now = this.now();
    const outcome = await this.db.transaction(async (tx) => {
      if (!(await this.takeGoogleNonce(tx, account.nonce))) return { kind: 'expired' } as const;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`google:${account.subject}`}, 0))`,
      );
      const rows = await tx
        .select()
        .from(googleAccounts)
        .where(
          or(eq(googleAccounts.subject, account.subject), eq(googleAccounts.userId, auth.userId)),
        );
      const same = rows.find(
        (row) => row.subject === account.subject && row.userId === auth.userId,
      );
      if (same) return { kind: 'connected', row: same } as const;
      if (rows.some((row) => row.subject === account.subject)) return { kind: 'taken' } as const;
      if (rows.length > 0) return { kind: 'another' } as const;
      const [row] = await tx
        .insert(googleAccounts)
        .values({ subject: account.subject, userId: auth.userId, email, createdAt: now })
        .onConflictDoNothing()
        .returning();
      if (!row) return { kind: 'another' } as const;
      await this.recordEvent(tx, auth.userId, 'google_connected', client);
      return { kind: 'connected', row } as const;
    });
    switch (outcome.kind) {
      case 'expired':
        throw this.challengeExpired();
      case 'taken':
        throw new AuthError(
          'GOOGLE_TAKEN',
          409,
          'This Google account signs in to another account. Disconnect it there first',
        );
      case 'another':
        throw new AuthError(
          'GOOGLE_CONNECTED',
          409,
          'Another Google account is connected to yours. Disconnect it first',
        );
      case 'connected':
        return { email: outcome.row.email, connectedAt: outcome.row.createdAt };
    }
  }

  /**
   * Disconnects the user's Google account (ADR-164), which signs them in no more; as
   * {@link connectGoogle} connects one. Refused while it is the account's only way in: a passkey,
   * a password or a number proved signs it in once it is gone.
   */
  async disconnectGoogle(auth: AuthenticatedSession, client: ClientInfo): Promise<void> {
    await this.mustHavePassedSecondFactor(auth, 'disconnecting Google');
    const outcome = await this.db.transaction(async (tx) => {
      const [connected] = await tx
        .select({ subject: googleAccounts.subject, phoneVerifiedAt: users.phoneVerifiedAt })
        .from(googleAccounts)
        .innerJoin(users, eq(users.id, googleAccounts.userId))
        .where(eq(googleAccounts.userId, auth.userId))
        .for('update');
      if (!connected) return 'none';
      const factors = await this.factorsOf(tx, auth.userId);
      if (!factors.password && factors.passkeys.length === 0 && !connected.phoneVerifiedAt) {
        return 'only';
      }
      await tx.delete(googleAccounts).where(eq(googleAccounts.subject, connected.subject));
      await this.recordEvent(tx, auth.userId, 'google_disconnected', client);
      return 'done';
    });
    if (outcome === 'none') {
      throw new AuthError('NOT_FOUND', 404, 'No Google account is connected to yours');
    }
    if (outcome === 'only') {
      throw new AuthError(
        'ONLY_SIGN_IN_METHOD',
        409,
        'Google is how you sign in. Add a passkey first, then disconnect it',
      );
    }
  }

  /** Google's ID tokens' checker, or an error where Google sign-in is not set up. */
  private googleTokens(): GoogleIdTokens {
    if (!this.google) {
      throw new AuthError(
        'GOOGLE_SIGN_IN_UNAVAILABLE',
        503,
        'Signing in with Google is not set up here. Sign in another way',
      );
    }
    return this.google;
  }

  /** What Google's ID token says of its account, once checked; refused otherwise. */
  private async checkGoogle(
    google: GoogleIdTokens,
    idToken: string,
    client: ClientInfo,
  ): Promise<GoogleAccount> {
    const checked = await google.check(idToken, this.now());
    if (checked.ok) return checked.account;
    if (checked.reason === 'unreachable') {
      throw new AuthError(
        'GOOGLE_UNREACHABLE',
        503,
        'Google could not be reached to check your sign-in. Try again in a moment',
      );
    }
    await this.recordEvent(this.db, null, 'google_sign_in_failed', client);
    throw new AuthError(
      'INVALID_GOOGLE_SIGN_IN',
      401,
      'Your sign-in with Google could not be checked. Try again',
    );
  }

  /** Spends a nonce {@link googleOptions} gave out: it answers once, before it expires. */
  private async takeGoogleNonce(tx: Executor, nonce: string): Promise<boolean> {
    const now = this.now();
    const taken = await tx
      .update(googleNonces)
      .set({ usedAt: now })
      .where(
        and(
          eq(googleNonces.nonce, nonce),
          isNull(googleNonces.usedAt),
          gt(googleNonces.expiresAt, now),
        ),
      )
      .returning({ nonce: googleNonces.nonce });
    return taken.length > 0;
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
    /** The Google account that signs them in, where one is connected (ADR-164). */
    google: GoogleConnection | null;
  }> {
    const user = await this.profileOf(this.db, auth.userId);
    const [google] = await this.db
      .select({ email: googleAccounts.email, connectedAt: googleAccounts.createdAt })
      .from(googleAccounts)
      .where(eq(googleAccounts.userId, auth.userId));
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
      google: google ?? null,
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
      otpauthUri: otpauthUri({ secret, issuer: this.issuer, account: accountName(user) }),
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
      userName: accountName(user),
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
          outcome.methods.length === 0
            ? 'Add a passkey or an authenticator app first: your account has no password'
            : outcome.methods.includes('password')
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
    step: 'password' | 'second_factor' | 'passkey' | 'phone' | 'google',
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
  ): Promise<{ totp: boolean; passkeys: PasskeyRow[]; password: boolean }> {
    const [totp] = await executor
      .select({ confirmedAt: totpCredentials.confirmedAt })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId));
    const [password] = await executor
      .select({ userId: passwordCredentials.userId })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId));
    return {
      totp: Boolean(totp?.confirmedAt),
      passkeys: await this.passkeysOf(executor, userId),
      password: Boolean(password),
    };
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

  /**
   * Refuses a change to the ways an account signs in, `doing` it, unless its user proved who they
   * are lately, after a second factor where the account has one: a stolen password alone changes
   * none of them.
   */
  private async mustHavePassedSecondFactor(
    auth: AuthenticatedSession,
    doing: string,
  ): Promise<void> {
    this.mustHaveAuthenticatedRecently(auth);
    const factors = await this.factorsOf(this.db, auth.userId);
    if ((factors.totp || factors.passkeys.length > 0) && !auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        `Sign in with a passkey or your authenticator app before ${doing}`,
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
    password: boolean;
  }): ReauthenticationMethod[] {
    const methods: ReauthenticationMethod[] = [
      ...(this.passkeys && factors.passkeys.length > 0 ? (['passkey'] as const) : []),
      ...(factors.totp ? (['totp'] as const) : []),
    ];
    if (methods.length > 0) return methods;
    // An account opened with a phone has no password: a second factor first (ADR-159).
    return factors.password ? ['password'] : [];
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
        phoneVerifiedAt: users.phoneVerifiedAt,
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
