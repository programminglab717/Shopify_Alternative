import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { MFA_REQUIRED_ROLES, isStaffRole, type StaffRole } from '@hatti/api';
import {
  SecretBox,
  base32Encode,
  otpauthUri,
  secretToken,
  sha256,
  verifyTotp,
} from '@hatti/crypto';
import type { Db } from '@hatti/db';
import { newId, toPublicId, tryFromPublicId } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import type { RateLimit, RateLimiter } from '@hatti/ratelimit';
import { metrics, type Counter } from '@opentelemetry/api';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AuthError, invalidCredentials, unauthenticated } from './errors.js';
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
  passwordCredentials,
  recoveryCodes,
  sessions,
  shops,
  totpCredentials,
  users,
} from './schema.js';

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
  session: { id: string; mfaVerified: boolean };
}

export type SignInResult =
  | { status: 'signed_in'; user: UserProfile; tokens: SessionTokens }
  | { status: 'mfa_required'; challengeToken: string; challengeExpiresAt: Date };

/** A caller of /auth endpoints, from its access token. */
export interface AuthenticatedSession {
  userId: string;
  sessionId: string;
  mfaVerified: boolean;
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

type Executor = Pick<Db, 'insert' | 'select' | 'update' | 'delete'>;

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
const ipOf = (client: ClientInfo): string | null =>
  client.ip && isIP(client.ip) !== 0 ? client.ip : null;
const userAgentOf = (client: ClientInfo): string | null => client.userAgent?.slice(0, 512) ?? null;

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
 * Staff sign-up and sign-in (password, then TOTP when enabled), sessions with rotating refresh
 * tokens, and two-step verification set-up. See docs/engineering/conventions.md#staff-sign-in.
 */
export class IdentityService {
  private readonly db: Db;
  private readonly secretBox: SecretBox;
  private readonly rateLimiter: RateLimiter | null;
  private readonly breaches: BreachedPasswordChecker;
  private readonly issuer: string;
  private readonly now: () => Date;
  /** Sign-in attempts by step and outcome; a jump in failures means credential stuffing. */
  private readonly signInAttempts: Counter;

  constructor(private readonly options: IdentityServiceOptions) {
    this.db = options.db;
    this.secretBox = options.secretBox;
    this.rateLimiter = options.rateLimiter ?? null;
    this.breaches = options.breachedPasswords ?? noBreachCheck;
    this.issuer = options.issuer ?? 'Hatti';
    this.now = options.now ?? (() => new Date());
    this.signInAttempts = metrics.getMeter('hatti.identity').createCounter('hatti.auth.sign_ins', {
      description: 'Sign-in attempts by step (password, second_factor) and outcome',
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

    if (row.totpConfirmedAt) {
      const challengeToken = secretToken(TOKEN_PREFIX.challenge);
      const challengeExpiresAt = new Date(this.now().getTime() + LIFETIMES.mfaChallengeMs);
      await this.db.insert(mfaChallenges).values({
        id: newId(),
        userId: row.id,
        tokenHash: sha256(challengeToken),
        expiresAt: challengeExpiresAt,
        ip: ipOf(client),
        userAgent: userAgentOf(client),
      });
      return { status: 'mfa_required', challengeToken, challengeExpiresAt };
    }

    const tokens = await this.db.transaction(async (tx) => {
      await this.recordEvent(tx, row.id, 'sign_in', client);
      return this.createSession(tx, row.id, false, client);
    });
    return { status: 'signed_in', user: toProfile(row, false), tokens };
  }

  /** Second step of sign-in: a TOTP code or a recovery code. */
  completeSignIn(
    input: { challengeToken: string; code: string },
    client: ClientInfo,
  ): Promise<{ user: UserProfile; tokens: SessionTokens }> {
    return this.counted('second_factor', () => this.secondFactorStep(input, client));
  }

  private async secondFactorStep(
    input: { challengeToken: string; code: string },
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
      const factor = await this.checkSecondFactor(tx, challenge.userId, input.code);
      if (!factor) {
        await tx
          .update(mfaChallenges)
          .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
          .where(eq(mfaChallenges.id, challenge.id));
        await this.recordEvent(tx, challenge.userId, 'second_factor_failed', client);
        return { kind: 'wrong_code' } as const;
      }
      await tx.update(mfaChallenges).set({ usedAt: now }).where(eq(mfaChallenges.id, challenge.id));
      await this.recordEvent(
        tx,
        challenge.userId,
        factor === 'recovery_code' ? 'sign_in_with_recovery_code' : 'sign_in',
        client,
      );
      const tokens = await this.createSession(tx, challenge.userId, true, client);
      return { kind: 'ok', tokens, user: await this.profileOf(tx, challenge.userId) } as const;
    });
    if (outcome.kind === 'expired') throw this.challengeExpired();
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

  async me(auth: AuthenticatedSession): Promise<{
    user: UserProfile;
    session: { id: string; mfaVerified: boolean };
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
      session: { id: toPublicId('session', auth.sessionId), mfaVerified: auth.mfaVerified },
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
   * Starts authenticator-app set-up. Replacing an existing authenticator needs a session that
   * already passed it, so a stolen password alone cannot swap in the thief's app.
   */
  async setUpTotp(auth: AuthenticatedSession): Promise<{ secret: string; otpauthUri: string }> {
    const [existing] = await this.db
      .select({ confirmedAt: totpCredentials.confirmedAt })
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, auth.userId));
    if (existing?.confirmedAt && !auth.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        'Sign in with your current authenticator app before replacing it',
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

      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, auth.userId));
      await tx.insert(recoveryCodes).values(
        codes.map((recoveryCode) => ({
          userId: auth.userId,
          codeHash: recoveryCodeHash(recoveryCode),
        })),
      );
      await this.recordEvent(tx, auth.userId, 'two_step_enabled', client);
      return { recoveryCodes: codes };
    });
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
    step: 'password' | 'second_factor',
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
    if (/^\d{6}$/.test(compact)) {
      const [credential] = await tx
        .select()
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId));
      if (!credential?.secretEncrypted) return null;
      const secret = this.secretBox.decrypt(credential.secretEncrypted, totpContext(userId));
      const step = verifyTotp(secret, compact, { timeMs: this.now().getTime() });
      // A code works once, even inside its 30-second window.
      if (step === null || (credential.lastUsedStep !== null && step <= credential.lastUsedStep)) {
        return null;
      }
      await tx
        .update(totpCredentials)
        .set({ lastUsedStep: step })
        .where(eq(totpCredentials.userId, userId));
      return 'totp';
    }
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
      session: { id: toPublicId('session', id), mfaVerified },
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
      })
      .from(users)
      .leftJoin(totpCredentials, eq(totpCredentials.userId, users.id))
      .where(eq(users.id, userId));
    if (!row) throw unauthenticated();
    return toProfile(row, row.totpConfirmedAt !== null);
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
