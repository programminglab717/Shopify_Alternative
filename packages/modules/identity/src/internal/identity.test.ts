import { randomBytes, randomInt } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import { SecretBox, base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { RateLimiter } from '@hatti/ratelimit';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { IdentityService, LIFETIMES, type ClientInfo } from './identity.service.js';
import { HaveIBeenPwnedChecker, hashPassword, needsRehash } from './passwords.js';
import * as schema from './schema.js';
import { StaffAccessResolver } from './staff-access.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const PASSWORD = 'correct horse battery staple';

/** A distinct client per call, so per-IP limits do not interfere between tests. */
const client = (): ClientInfo => ({
  ip: `203.0.113.${randomInt(1, 255)}`,
  userAgent: 'vitest',
});
const uniqueEmail = () => `staff-${randomBytes(4).toString('hex')}@example.pk`;

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('Expected an AuthError');
}

describe('passwords', () => {
  it('hashes with argon2id and knows when to rehash', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo')).toBe(true);
  });

  it('checks breaches by hash prefix only and fails open', async () => {
    let requested = '';
    const checker = new HaveIBeenPwnedChecker({
      fetch: async (url) => {
        requested = String(url);
        // SHA-1 of "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
        return new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\nABC:0\r\n');
      },
    });
    expect(await checker.isBreached('password')).toBe(true);
    expect(requested).toBe('https://api.pwnedpasswords.com/range/5BAA6');

    const errors: unknown[] = [];
    const offline = new HaveIBeenPwnedChecker({
      fetch: async () => {
        throw new Error('offline');
      },
      onError: (error) => errors.push(error),
    });
    expect(await offline.isBreached('password')).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe.skipIf(!server || !redisUrl)('IdentityService', () => {
  let testDb: TestDatabase;
  let identityDb: Database;
  let appDb: Database;
  let admin: pg.Client;
  let redis: Redis;
  let service: IdentityService;
  let resolver: StaffAccessResolver;
  let clock = Date.now();
  const secretBox = new SecretBox([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  const rateLimitPrefix = `test-auth-${randomBytes(4).toString('hex')}`;
  const shopA = newId();
  const shopB = newId();

  const signUp = async (email = uniqueEmail()) => {
    const result = await service.signUp(
      { email, password: PASSWORD, name: 'Ayesha Khan' },
      client(),
    );
    return { ...result, email };
  };
  const auth = async (accessToken: string) => service.authenticate(accessToken);
  const code = (secret: string, at = clock) => totp(base32Decode(secret), at);

  /** Signs up, enables TOTP and returns the secret. */
  async function signUpWithTotp() {
    const account = await signUp();
    const session = await auth(account.tokens.accessToken);
    const { secret } = await service.setUpTotp(session);
    const { recoveryCodes } = await service.confirmTotp(session, code(secret), client());
    return { ...account, secret, recoveryCodes };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    identityDb = new Database({ appUrl: testDb.identityUrl, applicationName: 'identity-test' });
    appDb = new Database({ appUrl: testDb.appUrl, applicationName: 'identity-test-app' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(
      `INSERT INTO control.shops (id, name) VALUES ($1, 'Shop A'), ($2, 'Shop B')`,
      [shopA, shopB],
    );
    redis = new Redis(redisUrl!);
    service = new IdentityService({
      db: identityDb.app,
      secretBox,
      rateLimiter: new RateLimiter(redis, rateLimitPrefix),
      breachedPasswords: { isBreached: async (password) => password === 'password12345' },
      now: () => new Date(clock),
    });
    resolver = new StaffAccessResolver(appDb.app);
  });

  afterAll(async () => {
    const keys = redis ? await redis.keys(`${rateLimitPrefix}:*`) : [];
    if (keys.length > 0) await redis.del(...keys);
    redis?.disconnect();
    await identityDb?.close();
    await appDb?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('matches the migrated tables', async () => {
    await identityDb.app.transaction(async (tx) => {
      for (const table of [
        schema.users,
        schema.passwordCredentials,
        schema.totpCredentials,
        schema.recoveryCodes,
        schema.sessions,
        schema.mfaChallenges,
        schema.memberships,
        schema.authEvents,
        schema.shops,
      ]) {
        await tx.select().from(table).limit(0);
      }
    });
  });

  describe('database roles', () => {
    it('keeps identity tables away from request-serving code', async () => {
      const denied = await appDb.app.execute(sql`select * from identity.users`).catch((e) => e);
      expect(denied.cause?.code ?? denied.code).toBe('42501');
    });

    it('keeps shop data away from the identity login', async () => {
      const denied = await identityDb.app
        .execute(sql`select * from catalog.products`)
        .catch((e) => e);
      expect(denied.cause?.code ?? denied.code).toBe('42501');
    });
  });

  describe('sign-up', () => {
    it('creates an account, normalising email and phone, and signs it in', async () => {
      const email = `Owner.${randomBytes(3).toString('hex')}@Example.PK`;
      const result = await service.signUp(
        { email, password: PASSWORD, name: ' Bilal Ahmed ', phone: '0300-1234567' },
        client(),
      );
      expect(result.user).toMatchObject({
        email: email.toLowerCase(),
        name: 'Bilal Ahmed',
        phone: '+923001234567',
        mfaEnabled: false,
      });
      expect(result.user.id).toMatch(/^usr_/);
      expect(result.tokens.accessToken).toMatch(/^hsa_[\w-]{43}$/);
      expect(result.tokens.refreshToken).toMatch(/^hsr_[\w-]{43}$/);
      expect(result.tokens.session.mfaVerified).toBe(false);

      const { rows } = await admin.query(
        'SELECT hash FROM identity.password_credentials WHERE user_id = $1',
        [result.userId],
      );
      expect(rows[0].hash).toMatch(/^\$argon2id\$/);
    });

    it('ignores a malformed client address instead of failing', async () => {
      const result = await service.signUp(
        { email: uniqueEmail(), password: PASSWORD, name: 'Proxy Test' },
        { ip: 'not-an-ip, 10.0.0.1', userAgent: 'x'.repeat(2_000) },
      );
      const { rows } = await admin.query(
        'SELECT ip, length(user_agent) AS agent FROM identity.sessions WHERE user_id = $1',
        [result.userId],
      );
      expect(rows).toEqual([{ ip: null, agent: 512 }]);
    });

    it('explains every problem with the details', async () => {
      const error = await authError(
        service.signUp(
          { email: 'not-an-email', password: 'short', name: '', phone: '12345' },
          client(),
        ),
      );
      expect(error.code).toBe('INVALID_INPUT');
      expect(Object.keys(error.details.fields ?? {}).sort()).toEqual(['email', 'name', 'phone']);

      const weak = async (password: string) =>
        (
          await authError(
            service.signUp({ email: 'ayesha.khan@example.pk', password, name: 'A' }, client()),
          )
        ).details.fields?.password;
      expect(await weak('short')).toBe('Use at least 10 characters');
      expect(await weak('password12345')).toMatch(/data breach/);
      expect(await weak('ayesha.khan-2026')).toMatch(/email address/);
    });

    it('refuses a second account for the same email, whatever its case', async () => {
      const { email } = await signUp();
      const error = await authError(
        service.signUp({ email: email.toUpperCase(), password: PASSWORD, name: 'X' }, client()),
      );
      expect(error.code).toBe('EMAIL_TAKEN');
    });
  });

  describe('sign-in', () => {
    it('signs in with the right password and refuses wrong or unknown ones alike', async () => {
      const { email } = await signUp();
      const result = await service.signIn(
        { email: email.toUpperCase(), password: PASSWORD },
        client(),
      );
      expect(result.status).toBe('signed_in');

      const wrong = await authError(
        service.signIn({ email, password: 'wrong password' }, client()),
      );
      const unknown = await authError(
        service.signIn({ email: uniqueEmail(), password: PASSWORD }, client()),
      );
      expect([wrong.code, wrong.message]).toEqual([unknown.code, unknown.message]);
      expect(wrong.code).toBe('INVALID_CREDENTIALS');
    });

    it('limits attempts per email', async () => {
      const { email } = await signUp();
      for (let i = 0; i < 10; i++) {
        await authError(service.signIn({ email, password: 'wrong password' }, client()));
      }
      const limited = await authError(service.signIn({ email, password: PASSWORD }, client()));
      expect(limited.code).toBe('RATE_LIMITED');
      expect(limited.details.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('sessions', () => {
    it('rotates refresh tokens and retires the old access token', async () => {
      const { tokens } = await signUp();
      clock += 60_000;
      const next = await service.refresh(tokens.refreshToken, client());
      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      expect(next.session.id).toBe(tokens.session.id);
      expect((await authError(auth(tokens.accessToken))).code).toBe('UNAUTHENTICATED');
      expect((await auth(next.accessToken)).mfaVerified).toBe(false);
    });

    it('ends the session when a used refresh token comes back', async () => {
      const { tokens } = await signUp();
      const next = await service.refresh(tokens.refreshToken, client());

      // Within seconds it is a client race: refused, but the session survives.
      const race = await authError(service.refresh(tokens.refreshToken, client()));
      expect(race.code).toBe('REFRESH_TOKEN_ALREADY_USED');
      await auth(next.accessToken);

      clock += LIFETIMES.refreshReuseGraceMs + 1_000;
      const reuse = await authError(service.refresh(tokens.refreshToken, client()));
      expect(reuse.code).toBe('SESSION_REVOKED');
      expect((await authError(auth(next.accessToken))).code).toBe('UNAUTHENTICATED');
      expect((await authError(service.refresh(next.refreshToken, client()))).code).toBe(
        'INVALID_REFRESH_TOKEN',
      );
    });

    it('expires idle sessions', async () => {
      const { tokens } = await signUp();
      clock += LIFETIMES.idleMs + 60_000;
      const error = await authError(service.refresh(tokens.refreshToken, client()));
      expect(error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('lists devices and signs out one or the current one', async () => {
      const { email, tokens: first } = await signUp();
      const second = await service.signIn({ email, password: PASSWORD }, client());
      if (second.status !== 'signed_in') throw new Error('expected a session');

      const current = await auth(second.tokens.accessToken);
      const listed = await service.listSessions(current);
      expect(listed.map((s) => [s.id, s.current])).toEqual([
        [second.tokens.session.id, true],
        [first.session.id, false],
      ]);

      await service.revokeSession(current, first.session.id, client());
      expect((await authError(auth(first.accessToken))).code).toBe('UNAUTHENTICATED');
      expect(
        (await authError(service.revokeSession(current, first.session.id, client()))).code,
      ).toBe('NOT_FOUND');

      await service.signOut(current, client());
      expect((await authError(auth(second.tokens.accessToken))).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('two-step verification', () => {
    it('stores the authenticator secret encrypted', async () => {
      const { userId, secret } = await signUpWithTotp();
      const { rows } = await admin.query(
        'SELECT secret_encrypted, pending_secret_encrypted FROM identity.totp_credentials WHERE user_id = $1',
        [userId],
      );
      expect(rows[0].secret_encrypted).toMatch(/^v1\.test\./);
      expect(rows[0].secret_encrypted).not.toContain(secret);
      expect(rows[0].pending_secret_encrypted).toBeNull();
    });

    it('rejects a wrong code during set-up', async () => {
      const { tokens } = await signUp();
      const session = await auth(tokens.accessToken);
      const { secret, otpauthUri } = await service.setUpTotp(session);
      expect(otpauthUri).toContain(`secret=${secret}`);
      const wrong = String((Number(code(secret)) + 1) % 1_000_000).padStart(6, '0');
      expect((await authError(service.confirmTotp(session, wrong, client()))).code).toBe(
        'INVALID_CODE',
      );
    });

    it('asks for a code after the password, and accepts each code once', async () => {
      const { email, secret } = await signUpWithTotp();
      clock += 30_000;

      const first = await service.signIn({ email, password: PASSWORD }, client());
      if (first.status !== 'mfa_required') throw new Error('expected a challenge');
      const wrong = await authError(
        service.completeSignIn({ challengeToken: first.challengeToken, code: '000000' }, client()),
      );
      expect(wrong.code).toBe('INVALID_CODE');
      const signedIn = await service.completeSignIn(
        { challengeToken: first.challengeToken, code: code(secret) },
        client(),
      );
      expect(signedIn.tokens.session.mfaVerified).toBe(true);
      expect(signedIn.user.mfaEnabled).toBe(true);

      // The challenge is spent, and the same code cannot open a second one.
      const reused = await authError(
        service.completeSignIn(
          { challengeToken: first.challengeToken, code: code(secret) },
          client(),
        ),
      );
      expect(reused.code).toBe('INVALID_CHALLENGE');
      const second = await service.signIn({ email, password: PASSWORD }, client());
      if (second.status !== 'mfa_required') throw new Error('expected a challenge');
      const replay = await authError(
        service.completeSignIn(
          { challengeToken: second.challengeToken, code: code(secret) },
          client(),
        ),
      );
      expect(replay.code).toBe('INVALID_CODE');
    });

    it('accepts each recovery code once', async () => {
      const { email, recoveryCodes } = await signUpWithTotp();
      expect(recoveryCodes).toHaveLength(10);
      expect(recoveryCodes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
      const signInWith = async (recovery: string) => {
        const challenge = await service.signIn({ email, password: PASSWORD }, client());
        if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');
        return service.completeSignIn(
          { challengeToken: challenge.challengeToken, code: recovery.toUpperCase() },
          client(),
        );
      };
      expect((await signInWith(recoveryCodes[0]!)).tokens.session.mfaVerified).toBe(true);
      expect((await authError(signInWith(recoveryCodes[0]!))).code).toBe('INVALID_CODE');
    });

    it('expires challenges and caps attempts', async () => {
      const { email } = await signUpWithTotp();
      const expired = await service.signIn({ email, password: PASSWORD }, client());
      if (expired.status !== 'mfa_required') throw new Error('expected a challenge');
      clock += LIFETIMES.mfaChallengeMs + 1_000;
      expect(
        (
          await authError(
            service.completeSignIn(
              { challengeToken: expired.challengeToken, code: '123456' },
              client(),
            ),
          )
        ).code,
      ).toBe('INVALID_CHALLENGE');

      const capped = await service.signIn({ email, password: PASSWORD }, client());
      if (capped.status !== 'mfa_required') throw new Error('expected a challenge');
      const attempt = () =>
        authError(
          service.completeSignIn(
            { challengeToken: capped.challengeToken, code: '000000' },
            client(),
          ),
        );
      for (let i = 0; i < 5; i++) expect((await attempt()).code).toBe('INVALID_CODE');
      expect((await attempt()).code).toBe('INVALID_CHALLENGE');
    });

    it('needs a verified session to replace an existing authenticator', async () => {
      const { email, secret } = await signUpWithTotp();
      clock += 30_000;
      const challenge = await service.signIn({ email, password: PASSWORD }, client());
      if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');
      const verified = await service.completeSignIn(
        { challengeToken: challenge.challengeToken, code: code(secret) },
        client(),
      );
      await expect(
        service.setUpTotp(await auth(verified.tokens.accessToken)),
      ).resolves.toMatchObject({
        secret: expect.any(String),
      });

      // A session that skipped the second factor (created before it was enabled) cannot.
      const { tokens } = await signUp();
      const unverified = await auth(tokens.accessToken);
      const { secret: other } = await service.setUpTotp(unverified);
      await service.confirmTotp(unverified, code(other), client());
      await admin.query('UPDATE identity.sessions SET mfa_verified_at = NULL WHERE id = $1', [
        unverified.sessionId,
      ]);
      const refused = await authError(service.setUpTotp(await auth(tokens.accessToken)));
      expect(refused.code).toBe('MFA_REQUIRED');
    });
  });

  describe('shop access', () => {
    const grant = (userId: string, shopId: string, role: StaffRole) =>
      service.grantMembership({ userId, shopId, role });

    it('lists the shops a user can open', async () => {
      const { userId, tokens } = await signUp();
      await grant(userId, shopA, 'packer');
      await grant(userId, shopB, 'manager');
      const me = await service.me(await auth(tokens.accessToken));
      expect(me.shops).toEqual([
        { id: toPublicId('shop', shopA), name: 'Shop A', role: 'packer', mfaRequired: false },
        { id: toPublicId('shop', shopB), name: 'Shop B', role: 'manager', mfaRequired: true },
      ]);
    });

    it('resolves staff access with role scopes, and refuses without membership', async () => {
      const { userId, tokens } = await signUp();
      await grant(userId, shopA, 'packer');
      const packer = await resolver.resolve(tokens.accessToken, shopA);
      expect(packer).toMatchObject({
        ok: true,
        tenant: {
          shopId: shopA,
          currency: 'PKR',
          scopes: new Set(['read_products', 'read_inventory', 'read_locations', 'write_orders']),
          actor: { kind: 'staff', userId, role: 'packer' },
        },
      });
      expect(await resolver.resolve(tokens.accessToken, shopB)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      expect(await resolver.resolve('hsa_' + 'x'.repeat(43), shopA)).toEqual({
        ok: false,
        reason: 'unauthenticated',
      });

      await admin.query(`UPDATE identity.memberships SET status = 'suspended' WHERE user_id = $1`, [
        userId,
      ]);
      expect(await resolver.resolve(tokens.accessToken, shopA)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
    });

    it('requires two-step verification for owners', async () => {
      const { userId, tokens } = await signUp();
      await grant(userId, shopA, 'owner');
      expect(await resolver.resolve(tokens.accessToken, shopA)).toEqual({
        ok: false,
        reason: 'mfa_required',
      });

      const session = await auth(tokens.accessToken);
      const { secret } = await service.setUpTotp(session);
      await service.confirmTotp(session, code(secret), client());
      const owner = await resolver.resolve(tokens.accessToken, shopA);
      expect(owner.ok && [...owner.tenant.scopes]).toEqual([
        'write_products',
        'write_inventory',
        'write_locations',
        'write_orders',
        'write_customers',
        'write_segments',
      ]);
    });

    it('stops working the moment the session is revoked', async () => {
      const { userId, tokens } = await signUp();
      await grant(userId, shopA, 'marketer');
      expect((await resolver.resolve(tokens.accessToken, shopA)).ok).toBe(true);
      await service.signOut(await auth(tokens.accessToken), client());
      expect(await resolver.resolve(tokens.accessToken, shopA)).toEqual({
        ok: false,
        reason: 'unauthenticated',
      });
    });
  });
});
