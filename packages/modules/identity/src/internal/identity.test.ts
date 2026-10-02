import { randomBytes, randomInt } from 'node:crypto';
import { SUPPORT_SCOPES, type StaffRole } from '@hatti/api';
import { SecretBox, base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { RateLimiter } from '@hatti/ratelimit';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoftAuthenticator } from '../testing/index.js';
import { AuthError } from './errors.js';
import { IdentityService, LIFETIMES, type ClientInfo } from './identity.service.js';
import { HaveIBeenPwnedChecker, hashPassword, needsRehash } from './passwords.js';
import * as schema from './schema.js';
import { SHOP_LIMITS, handleFrom, handleProblem } from './shops.js';
import { StaffAccessResolver } from './staff-access.js';
import { STAFF_LIMITS, StaffService } from './staff.service.js';
import { SupportAccessService } from './support-access.service.js';

const server = testDatabaseServer();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl && process.env.CI) throw new Error('REDIS_URL must be set in CI');

const PASSWORD = 'correct horse battery staple';
/** The admin's origin, and the passkeys' relying party. */
const ORIGIN = 'http://localhost:4000';
const PASSKEYS = { rpId: 'localhost', rpName: 'Hatti', origins: [ORIGIN] };

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

describe('shop handles', () => {
  it("makes a handle from a shop's name: its Latin words, joined, never the platform's own", () => {
    expect(handleFrom('  Zari Fashions  ')).toBe('zari-fashions');
    expect(handleFrom('Café Lahore & Co.')).toBe('cafe-lahore-co');
    expect(handleFrom('Shop')).toBe('shop-store');
    // A name written in Urdu has none.
    expect(handleFrom(String.fromCharCode(0x632, 0x631, 0x6cc))).toBe('shop-store');
    const long = handleFrom('The Very Best Embroidered Lawn Suits Of Multan City');
    expect(long).toBe('the-very-best-embroidered-lawn-suits-of');
    expect(handleProblem(long)).toBeNull();
  });

  it('takes handles as the storefront serves them', () => {
    for (const ok of ['zari', 'a', 'zari-fashions-2', '786-store'])
      expect(handleProblem(ok)).toBeNull();
    for (const bad of [
      '',
      '-zari',
      'zari-',
      'zari--fashions',
      'Zari',
      'zari_fashions',
      'x'.repeat(41),
    ]) {
      expect(handleProblem(bad), bad).toMatch(/^Use 1 to 40/);
    }
    expect(handleProblem('admin')).toBe('This handle is kept for the platform');
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
      passkeys: PASSKEYS,
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
        schema.passkeys,
        schema.passkeyChallenges,
        schema.invitations,
        schema.memberships,
        schema.supportAgents,
        schema.supportGrants,
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

  describe('passkeys (ADR-100)', () => {
    /** Signs up and adds a passkey from the new session: the account's first second factor. */
    async function signUpWithPasskey(authenticator = new SoftAuthenticator(ORIGIN)) {
      const account = await signUp();
      const session = await auth(account.tokens.accessToken);
      const options = await service.passkeyRegistrationOptions(session);
      const added = await service.registerPasskey(
        session,
        { response: authenticator.create(options), name: ' Work laptop ' },
        client(),
      );
      return { ...account, session, authenticator, ...added };
    }
    const signInWith = async (authenticator: SoftAuthenticator, origin?: string) =>
      service.signInWithPasskey(
        { response: authenticator.get(await service.passkeySignInOptions(client()), origin) },
        client(),
      );

    it('adds a passkey from a session, with recovery codes as the first second factor', async () => {
      const account = await signUp();
      const session = await auth(account.tokens.accessToken);
      const options = await service.passkeyRegistrationOptions(session);
      expect(options).toMatchObject({
        rp: { id: 'localhost', name: 'Hatti' },
        user: { name: account.email, displayName: 'Ayesha Khan' },
        attestation: 'none',
        excludeCredentials: [],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const authenticator = new SoftAuthenticator(ORIGIN);
      const response = authenticator.create(options);
      const added = await service.registerPasskey(
        session,
        { response, name: ' Work laptop ' },
        client(),
      );
      expect(added.passkey).toEqual({
        id: expect.stringMatching(/^psk_/),
        name: 'Work laptop',
        multiDevice: false,
        backedUp: false,
        createdAt: new Date(clock),
        lastUsedAt: null,
      });
      expect(added.recoveryCodes).toHaveLength(10);
      expect(await service.listPasskeys(session)).toEqual([added.passkey]);
      expect((await service.me(session)).user.mfaEnabled).toBe(true);
      const { rows } = await admin.query(
        `SELECT credential_id, counter, transports, length(public_key) > 0 AS key
           FROM identity.passkeys WHERE user_id = $1`,
        [account.userId],
      );
      expect(rows).toEqual([
        { credential_id: response.id, counter: '0', transports: ['internal', 'hybrid'], key: true },
      ]);
      // Another, now the account has a second factor, from a session that passed it alone.
      expect((await authError(service.passkeyRegistrationOptions(session))).code).toBe(
        'MFA_REQUIRED',
      );
      expect((await authError(service.registerPasskey(session, { response }, client()))).code).toBe(
        'MFA_REQUIRED',
      );
      const verified = await auth((await signInWith(authenticator)).tokens.accessToken);
      const next = await service.passkeyRegistrationOptions(verified);
      expect(next.excludeCredentials).toEqual([
        { id: response.id, type: 'public-key', transports: ['internal', 'hybrid'] },
      ]);
      // Made on another site, it is refused, its challenge spent all the same.
      const phone = new SoftAuthenticator(ORIGIN, { synced: true });
      const elsewhere = phone.create(next, 'https://hatti.example');
      expect(
        (await authError(service.registerPasskey(verified, { response: elsewhere }, client())))
          .code,
      ).toBe('INVALID_PASSKEY');
      const again = phone.create(await service.passkeyRegistrationOptions(verified));
      const second = await service.registerPasskey(verified, { response: again }, client());
      expect(second).toEqual({
        passkey: expect.objectContaining({ name: 'Passkey', multiDevice: true, backedUp: true }),
        recoveryCodes: null,
      });
      // Its challenge answers once.
      expect(
        (await authError(service.registerPasskey(verified, { response: again }, client()))).code,
      ).toBe('INVALID_CHALLENGE');
      // One its user didn't verify is not taken.
      const careless = new SoftAuthenticator(ORIGIN, { verifiesUser: false });
      const unverified = careless.create(await service.passkeyRegistrationOptions(verified));
      expect(
        (await authError(service.registerPasskey(verified, { response: unverified }, client())))
          .code,
      ).toBe('INVALID_PASSKEY');
      expect((await service.listPasskeys(verified)).map((key) => key.name)).toEqual([
        'Work laptop',
        'Passkey',
      ]);
    });

    it('signs in with a passkey alone, which passes the second factor', async () => {
      const { userId, authenticator } = await signUpWithPasskey();
      clock += 1_000;
      const signedIn = await signInWith(authenticator);
      expect(signedIn.tokens.session.mfaVerified).toBe(true);
      expect(signedIn.user).toMatchObject({ id: toPublicId('user', userId), mfaEnabled: true });
      const { rows } = await admin.query(
        `SELECT counter, last_used_at FROM identity.passkeys WHERE user_id = $1`,
        [userId],
      );
      expect(rows).toEqual([{ counter: '1', last_used_at: new Date(clock) }]);
      const events = await admin.query(
        `SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id`,
        [userId],
      );
      expect(events.rows.map((row) => row.kind)).toEqual([
        'sign_up',
        'passkey_added',
        'sign_in_with_passkey',
      ]);

      // A response answers its challenge once.
      const options = await service.passkeySignInOptions(client());
      const response = authenticator.get(options);
      await service.signInWithPasskey({ response }, client());
      expect((await authError(service.signInWithPasskey({ response }, client()))).code).toBe(
        'INVALID_CHALLENGE',
      );
      // Signed for another site, by a passkey no one added, or by a copy whose counter went
      // back, it signs no one in.
      expect((await authError(signInWith(authenticator, 'https://hatti.example'))).code).toBe(
        'INVALID_PASSKEY',
      );
      const stranger = new SoftAuthenticator(ORIGIN);
      stranger.create(
        await service.passkeyRegistrationOptions(await auth((await signUp()).tokens.accessToken)),
      );
      expect((await authError(signInWith(stranger))).code).toBe('INVALID_PASSKEY');
      await admin.query('UPDATE identity.passkeys SET counter = 100 WHERE user_id = $1', [userId]);
      expect((await authError(signInWith(authenticator))).code).toBe('INVALID_PASSKEY');
      // Nor a disabled account's.
      await admin.query('UPDATE identity.passkeys SET counter = 0 WHERE user_id = $1', [userId]);
      await admin.query(`UPDATE identity.users SET status = 'disabled' WHERE id = $1`, [userId]);
      expect((await authError(signInWith(authenticator))).code).toBe('INVALID_PASSKEY');
    });

    it('signs in with a synced passkey, which keeps no counter, again and again', async () => {
      const { authenticator } = await signUpWithPasskey(
        new SoftAuthenticator(ORIGIN, { synced: true }),
      );
      for (let i = 0; i < 2; i++) {
        expect((await signInWith(authenticator)).tokens.session.mfaVerified).toBe(true);
      }
    });

    it("asks for one of the user's passkeys after their password", async () => {
      const { email, authenticator, recoveryCodes } = await signUpWithPasskey();
      const challenge = await service.signIn({ email, password: PASSWORD }, client());
      if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');
      expect(challenge.methods).toEqual(['passkey', 'recovery_code']);
      expect(challenge.passkeyOptions).toMatchObject({
        rpId: 'localhost',
        userVerification: 'required',
        allowCredentials: [{ id: authenticator.passkeyIds[0], type: 'public-key' }],
      });
      // Another's passkey doesn't answer it.
      const other = await signUpWithPasskey();
      const wrong = await authError(
        service.completeSignIn(
          {
            challengeToken: challenge.challengeToken,
            passkey: other.authenticator.get(
              { ...challenge.passkeyOptions!, allowCredentials: [] },
              ORIGIN,
            ),
          },
          client(),
        ),
      );
      expect(wrong.code).toBe('INVALID_PASSKEY');
      const signedIn = await service.completeSignIn(
        {
          challengeToken: challenge.challengeToken,
          passkey: authenticator.get(challenge.passkeyOptions!),
        },
        client(),
      );
      expect(signedIn.tokens.session.mfaVerified).toBe(true);
      // Or a recovery code, for a passkey lost.
      const lost = await service.signIn({ email, password: PASSWORD }, client());
      if (lost.status !== 'mfa_required') throw new Error('expected a challenge');
      const recovered = await service.completeSignIn(
        { challengeToken: lost.challengeToken, code: recoveryCodes![0]! },
        client(),
      );
      expect(recovered.tokens.session.mfaVerified).toBe(true);
    });

    it('takes a passkey away, or adds an authenticator app beside one, only after a second factor', async () => {
      const { session, authenticator, passkey } = await signUpWithPasskey();
      expect((await authError(service.removePasskey(session, passkey.id, client()))).code).toBe(
        'MFA_REQUIRED',
      );
      expect((await authError(service.setUpTotp(session))).code).toBe('MFA_REQUIRED');
      const verified = await auth((await signInWith(authenticator)).tokens.accessToken);
      await expect(service.setUpTotp(verified)).resolves.toMatchObject({
        secret: expect.any(String),
      });
      const other = await signUpWithPasskey();
      expect(
        (await authError(service.removePasskey(verified, other.passkey.id, client()))).code,
      ).toBe('NOT_FOUND');
      await service.removePasskey(verified, passkey.id, client());
      expect(await service.listPasskeys(verified)).toEqual([]);
      expect((await authError(signInWith(authenticator))).code).toBe('INVALID_PASSKEY');
    });

    it('serves no passkeys without their settings', async () => {
      const without = new IdentityService({ db: identityDb.app, secretBox });
      expect((await authError(without.passkeySignInOptions(client()))).code).toBe(
        'PASSKEYS_UNAVAILABLE',
      );
    });
  });

  describe('re-authentication (ADR-103)', () => {
    /** Makes the session's last proof of who its user is 20 minutes older. */
    async function age(session: { sessionId: string }) {
      await admin.query(
        `UPDATE identity.sessions SET authenticated_at = authenticated_at - interval '20 minutes'
          WHERE id = $1`,
        [session.sessionId],
      );
    }
    const kinds = async (userId: string) =>
      (
        await admin.query<{ kind: string }>(
          'SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id',
          [userId],
        )
      ).rows.map((row) => row.kind);
    async function addPasskey(accessToken: string) {
      const session = await auth(accessToken);
      const authenticator = new SoftAuthenticator(ORIGIN);
      const options = await service.passkeyRegistrationOptions(session);
      await service.registerPasskey(session, { response: authenticator.create(options) }, client());
      return authenticator;
    }

    it('asks for the password where the account has no second factor', async () => {
      const account = await signUp();
      expect(account.tokens.session.authenticatedAt).toEqual(new Date(clock));
      const session = await auth(account.tokens.accessToken);
      expect(session.authenticatedAt).toEqual(new Date(clock));
      await age(session);
      const stale = await auth(account.tokens.accessToken);
      // Changes to how the account signs in wait for it.
      for (const change of [service.setUpTotp(stale), service.passkeyRegistrationOptions(stale)]) {
        expect(await authError(change)).toMatchObject({
          code: 'REAUTHENTICATION_REQUIRED',
          status: 403,
        });
      }
      expect(await service.reauthenticationOptions(stale)).toEqual({
        methods: ['password'],
        passkeyOptions: null,
      });
      expect(
        await authError(service.reauthenticate(stale, { password: 'not my password' }, client())),
      ).toMatchObject({ code: 'INVALID_PASSWORD', status: 422 });
      expect(
        await authError(service.reauthenticate(stale, { code: '123456' }, client())),
      ).toMatchObject({
        code: 'INVALID_METHOD',
        message: 'Confirm with your password: your account has no passkey or authenticator app',
      });
      expect(await service.reauthenticate(stale, { password: PASSWORD }, client())).toEqual({
        authenticatedAt: new Date(clock),
        sensitiveActionsUntil: new Date(clock + 15 * 60_000),
      });
      const confirmed = await auth(account.tokens.accessToken);
      expect(confirmed).toMatchObject({ authenticatedAt: new Date(clock), mfaVerified: false });
      expect((await service.me(confirmed)).session.authenticatedAt).toEqual(new Date(clock));
      await service.setUpTotp(confirmed);
      expect(await kinds(session.userId)).toEqual([
        'sign_up',
        'reauthentication_failed',
        'reauthenticated',
      ]);
      // Refreshing keeps when its user last proved who they are.
      await age(confirmed);
      const refreshed = await service.refresh(account.tokens.refreshToken, client());
      expect(refreshed.session.authenticatedAt).toEqual(new Date(clock - 20 * 60_000));
    });

    it('asks for the second factor where the account has one: a code once, never a recovery code', async () => {
      const account = await signUpWithTotp();
      const session = await auth(account.tokens.accessToken);
      await age(session);
      const stale = await auth(account.tokens.accessToken);
      expect(await service.reauthenticationOptions(stale)).toEqual({
        methods: ['totp'],
        passkeyOptions: null,
      });
      expect(
        await authError(service.reauthenticate(stale, { password: PASSWORD }, client())),
      ).toMatchObject({
        code: 'INVALID_METHOD',
        message: 'Confirm with your passkey or authenticator app: your account has one',
      });
      // Recovery codes are for a lost phone.
      expect(
        await authError(
          service.reauthenticate(stale, { code: account.recoveryCodes[0]! }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_CODE' });
      clock += 30_000;
      const now = code(account.secret);
      await service.reauthenticate(stale, { code: now }, client());
      expect(await auth(account.tokens.accessToken)).toMatchObject({
        authenticatedAt: new Date(clock),
      });
      expect(await authError(service.reauthenticate(stale, { code: now }, client()))).toMatchObject(
        { code: 'INVALID_CODE' },
      );
    });

    it("confirms with a passkey of the user's own, which passes the second factor", async () => {
      const ayesha = await signUp();
      const laptop = await addPasskey(ayesha.tokens.accessToken);
      const bilal = await signUp();
      const phone = await addPasskey(bilal.tokens.accessToken);
      await age(await auth(ayesha.tokens.accessToken));
      const stale = await auth(ayesha.tokens.accessToken);
      // Added in the session she signed up in, her passkey has not answered a second step yet.
      expect(stale.mfaVerified).toBe(false);
      const options = await service.reauthenticationOptions(stale);
      expect(options).toMatchObject({
        methods: ['passkey'],
        passkeyOptions: {
          rpId: 'localhost',
          userVerification: 'required',
          allowCredentials: [{ id: laptop.passkeyIds[0], type: 'public-key' }],
        },
      });
      // Bilal's passkey is not hers, and spends the challenge all the same.
      const borrowed = phone.get(options.passkeyOptions!, ORIGIN, phone.passkeyIds[0]);
      expect(
        await authError(service.reauthenticate(stale, { passkey: borrowed }, client())),
      ).toMatchObject({ code: 'INVALID_PASSKEY' });
      expect(
        await authError(
          service.reauthenticate(stale, { passkey: laptop.get(options.passkeyOptions!) }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_PASSKEY' });
      const again = await service.reauthenticationOptions(stale);
      await service.reauthenticate(stale, { passkey: laptop.get(again.passkeyOptions!) }, client());
      const confirmed = await auth(ayesha.tokens.accessToken);
      expect(confirmed).toMatchObject({ authenticatedAt: new Date(clock), mfaVerified: true });
      // Now she may add another passkey.
      expect(await service.passkeyRegistrationOptions(confirmed)).toMatchObject({
        excludeCredentials: [{ id: laptop.passkeyIds[0] }],
      });
    });
  });

  describe('staff (ADR-101)', () => {
    const staff = () => new StaffService({ db: identityDb.app, now: () => new Date(clock) });
    /** A shop of its own, with its owner. */
    async function shopWithOwner(name = 'Zari') {
      const shopId = newId();
      await admin.query('INSERT INTO control.shops (id, name) VALUES ($1, $2)', [shopId, name]);
      const owner = await signUp();
      await service.grantMembership({ userId: owner.userId, shopId, role: 'owner' });
      return { shopId, owner };
    }
    const errorsOf = (result: { ok: boolean; errors?: { field: string[]; code: string }[] }) =>
      result.ok ? [] : result.errors!.map((error) => [error.field.join('.'), error.code]);
    const messageOf = (result: { ok: boolean; errors?: { message: string }[] }) =>
      result.ok ? null : result.errors![0]!.message;

    it('hands the shop to a manager with a second factor, the owner staying on as one (ADR-104)', async () => {
      const { shopId, owner } = await shopWithOwner('Gota');
      const manager = await signUp();
      const packer = await signUp();
      await service.grantMembership({ userId: manager.userId, shopId, role: 'manager' });
      await service.grantMembership({ userId: packer.userId, shopId, role: 'packer' });
      const transfer = (from: string, to: string) =>
        staff().transferOwnership({ userId: from }, shopId, to, client());

      // Only the owner hands it over, and only to a manager of the shop.
      expect(messageOf(await transfer(manager.userId, packer.userId))).toBe(
        'Only the owner hands the shop over',
      );
      expect(messageOf(await transfer(owner.userId, owner.userId))).toBe(
        'You own the shop already',
      );
      expect(messageOf(await transfer(owner.userId, packer.userId))).toBe(
        'The shop goes to a manager: make them one first',
      );
      expect(errorsOf(await transfer(owner.userId, newId()))).toEqual([
        ['staffMemberId', 'NOT_FOUND'],
      ]);
      // Without a second factor, they would own a shop they could not open.
      expect(messageOf(await transfer(owner.userId, manager.userId))).toBe(
        "A shop's owner needs a passkey or an authenticator app: ask them to add one first",
      );
      const session = await auth(manager.tokens.accessToken);
      const { secret } = await service.setUpTotp(session);
      await service.confirmTotp(session, code(secret), client());

      expect(await transfer(owner.userId, manager.userId)).toMatchObject({
        ok: true,
        value: {
          owner: { userId: manager.userId, role: 'owner' },
          previousOwner: { userId: owner.userId, role: 'manager' },
        },
      });
      const { rows } = await admin.query<{ user_id: string; role: string }>(
        'SELECT user_id, role FROM identity.memberships WHERE shop_id = $1 ORDER BY role',
        [shopId],
      );
      expect(rows).toEqual([
        { user_id: owner.userId, role: 'manager' },
        { user_id: manager.userId, role: 'owner' },
        { user_id: packer.userId, role: 'packer' },
      ]);
      // The new owner's access says so from their next request.
      expect(await resolver.resolve(manager.tokens.accessToken, shopId)).toMatchObject({
        ok: true,
        tenant: { actor: { kind: 'staff', role: 'owner' } },
      });
      // A manager now, the old owner cannot take it back.
      expect(messageOf(await transfer(owner.userId, manager.userId))).toBe(
        'Only the owner hands the shop over',
      );
      const kinds = async (userId: string) =>
        (
          await admin.query<{ kind: string }>(
            "SELECT kind FROM identity.auth_events WHERE user_id = $1 AND kind LIKE 'shop_%'",
            [userId],
          )
        ).rows.map((row) => row.kind);
      expect([await kinds(owner.userId), await kinds(manager.userId)]).toEqual([
        ['shop_handed_over'],
        ['shop_received'],
      ]);
    });

    it('invites someone by a link they accept, once, once signed in', async () => {
      const { shopId, owner } = await shopWithOwner();
      const invited = await staff().invite(
        owner,
        shopId,
        { role: 'packer', note: ' Bilal, packing ' },
        client(),
      );
      if (!invited.ok) throw new Error('expected an invitation');
      const { invitation, token } = invited.value;
      expect(token).toMatch(/^hsi_[\w-]{43}$/);
      expect(invitation).toEqual({
        id: expect.any(String),
        role: 'packer',
        note: 'Bilal, packing',
        invitedBy: { userId: owner.userId, name: 'Ayesha Khan' },
        createdAt: new Date(clock),
        expiresAt: new Date(clock + STAFF_LIMITS.invitationMs),
      });
      expect(await staff().invitationsOf(shopId)).toEqual([invitation]);
      expect(await staff().preview(token)).toEqual({
        shop: { name: 'Zari' },
        role: 'packer',
        invitedBy: 'Ayesha Khan',
        expiresAt: invitation.expiresAt,
      });

      const bilal = await signUp();
      expect(await staff().accept(bilal, token, client())).toEqual({
        id: toPublicId('shop', shopId),
        name: 'Zari',
        role: 'packer',
        mfaRequired: false,
      });
      expect((await service.me(await auth(bilal.tokens.accessToken))).shops).toContainEqual(
        expect.objectContaining({ name: 'Zari', role: 'packer' }),
      );
      // Spent: no one else joins with it, and it waits no more.
      const other = await signUp();
      expect((await authError(staff().accept(other, token))).code).toBe('INVALID_INVITATION');
      expect(await staff().preview(token)).toBeNull();
      expect(await staff().invitationsOf(shopId)).toEqual([]);
      expect((await staff().staffOf(shopId)).map((member) => [member.email, member.role])).toEqual([
        [owner.email, 'owner'],
        [bilal.email, 'packer'],
      ]);
      // Someone who works there already keeps their role.
      const again = await staff().invite(owner, shopId, { role: 'manager' });
      if (!again.ok) throw new Error('expected an invitation');
      expect((await authError(staff().accept(bilal, again.value.token))).code).toBe(
        'ALREADY_MEMBER',
      );
      expect((await authError(staff().accept(bilal, 'hsi_nonsense'))).code).toBe(
        'INVALID_INVITATION',
      );
    });

    it("keeps the owner's powers and the managers' apart", async () => {
      const { shopId, owner } = await shopWithOwner();
      const join = async (role: StaffRole) => {
        const account = await signUp();
        await service.grantMembership({ userId: account.userId, shopId, role });
        return account;
      };
      const manager = await join('manager');
      const packer = await join('packer');
      const s = staff();
      // Nobody invites an owner; managers invite those below them; others, no one.
      expect(messageOf(await s.invite(owner, shopId, { role: 'owner' }))).toBe(
        'A shop has one owner, who is never invited or changed so',
      );
      expect(messageOf(await s.invite(manager, shopId, { role: 'manager' }))).toBe(
        'Only the owner invites and manages managers',
      );
      expect(messageOf(await s.invite(packer, shopId, { role: 'packer' }))).toBe(
        'Only the owner and managers manage staff',
      );
      expect(errorsOf(await s.invite(owner, shopId, { role: 'cashier' }))).toEqual([
        ['role', 'INVALID'],
      ]);
      const forManager = await s.invite(owner, shopId, { role: 'manager' });
      expect(errorsOf(await s.invite(manager, shopId, { role: 'accountant' }))).toEqual([]);
      // Roles: a manager changes those below them, never their own, the owner's or a manager's.
      expect(
        await s.changeRole(manager, shopId, packer.userId, 'marketer', client()),
      ).toMatchObject({
        ok: true,
        value: { member: { role: 'marketer' }, previousRole: 'packer' },
      });
      expect(messageOf(await s.changeRole(manager, shopId, packer.userId, 'manager'))).toBe(
        'Only the owner invites and manages managers',
      );
      expect(messageOf(await s.changeRole(manager, shopId, owner.userId, 'packer'))).toBe(
        'A shop has one owner, who is never invited or changed so',
      );
      expect(messageOf(await s.changeRole(manager, shopId, manager.userId, 'packer'))).toBe(
        'Your own role is changed by the owner',
      );
      expect(await s.changeRole(owner, shopId, manager.userId, 'accountant')).toMatchObject({
        ok: true,
        value: { member: { role: 'accountant' }, previousRole: 'manager' },
      });
      // Removing: the owner never; whoever else a member manages.
      expect(errorsOf(await s.remove(manager, shopId, owner.userId))).toEqual([['id', 'INVALID']]);
      expect(await s.remove(owner, shopId, manager.userId, client())).toEqual({
        ok: true,
        value: { userId: manager.userId, role: 'accountant' },
      });
      expect(errorsOf(await s.remove(owner, shopId, manager.userId))).toEqual([
        ['id', 'NOT_FOUND'],
      ]);
      expect((await s.staffOf(shopId)).map((member) => member.role)).toEqual(['owner', 'marketer']);
      // Taken back by whoever manages its role; then it opens nothing.
      if (!forManager.ok) throw new Error('expected an invitation');
      const removedManager = manager;
      expect(
        errorsOf(await s.revokeInvitation(removedManager, shopId, forManager.value.invitation.id)),
      ).toEqual([['id', 'INVALID']]);
      expect(
        await s.revokeInvitation(owner, shopId, forManager.value.invitation.id, client()),
      ).toMatchObject({ ok: true, value: { role: 'manager' } });
      expect(
        errorsOf(await s.revokeInvitation(owner, shopId, forManager.value.invitation.id)),
      ).toEqual([['id', 'NOT_FOUND']]);
      expect((await authError(s.accept(packer, forManager.value.token))).code).toBe(
        'INVALID_INVITATION',
      );
      // Each shop its own: another shop's owner changes nothing here.
      const { owner: stranger } = await shopWithOwner('Other');
      expect(errorsOf(await s.remove(stranger, shopId, packer.userId))).toEqual([
        ['id', 'INVALID'],
      ]);
      const events = await admin.query(
        `SELECT kind FROM identity.auth_events WHERE user_id = $1 AND kind LIKE 'staff_%'
          ORDER BY occurred_at, id`,
        [owner.userId],
      );
      expect(events.rows.map((row) => row.kind)).toEqual([
        'staff_invited',
        'staff_role_changed',
        'staff_removed',
        'staff_invitation_revoked',
      ]);
    });

    it('lets an invitation lapse after 7 days, and keeps 50 waiting at most', async () => {
      const { shopId, owner } = await shopWithOwner();
      const invited = await staff().invite(owner, shopId, { role: 'marketer' });
      if (!invited.ok) throw new Error('expected an invitation');
      clock += STAFF_LIMITS.invitationMs;
      expect(await staff().preview(invited.value.token)).toBeNull();
      expect((await authError(staff().accept(await signUp(), invited.value.token))).code).toBe(
        'INVALID_INVITATION',
      );
      for (let i = 0; i < STAFF_LIMITS.pendingInvitations; i++) {
        expect((await staff().invite(owner, shopId, { role: 'packer' })).ok).toBe(true);
      }
      expect(errorsOf(await staff().invite(owner, shopId, { role: 'packer' }))).toEqual([
        ['role', 'TOO_MANY'],
      ]);
    });

    it("keeps members and invitations waiting within the shop's plan's limit, as given (ADR-154)", async () => {
      const { shopId, owner } = await shopWithOwner();
      const limit = { limit: 2, plan: 'Starter' };
      expect((await staff().invite(owner, shopId, { role: 'packer' }, {}, limit)).ok).toBe(true);
      const full = await staff().invite(owner, shopId, { role: 'packer' }, {}, limit);
      expect(full.ok ? null : full.errors).toEqual([
        {
          field: ['role'],
          code: 'TOO_MANY',
          message:
            'The Starter plan has room for 2 members of staff: choose a bigger plan for more',
        },
      ]);
      // Without a limit, as for an app or a host with no billing, only the platform's.
      expect((await staff().invite(owner, shopId, { role: 'packer' })).ok).toBe(true);
    });
  });

  describe('shop access', () => {
    const grant = (userId: string, shopId: string, role: StaffRole) =>
      service.grantMembership({ userId, shopId, role });

    it('opens a shop its user owns, in the control plane, for its storefront to be published (ADR-145)', async () => {
      const { tokens } = await signUp();
      const session = await auth(tokens.accessToken);
      const opened = await service.openShop(session, { name: '  Zari Fashions  ' }, client());
      expect(opened).toMatchObject({
        name: 'Zari Fashions',
        handle: 'zari-fashions',
        role: 'owner',
        mfaRequired: true,
      });
      const shopId = fromPublicId(opened.id, 'shop');
      // With Pakistan's currency and time zone.
      const { rows: shops } = await admin.query(
        'SELECT name, handle, status, currency, timezone FROM control.shops WHERE id = $1',
        [shopId],
      );
      expect(shops).toEqual([
        {
          name: 'Zari Fashions',
          handle: 'zari-fashions',
          status: 'active',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
        },
      ]);
      expect((await service.me(session)).shops).toEqual([
        { id: opened.id, name: 'Zari Fashions', role: 'owner', mfaRequired: true },
      ]);
      // The worker hears of it, to publish its storefront.
      const { rows: events } = await admin.query(
        `SELECT event_type, aggregate_type, aggregate_id, payload
           FROM platform.outbox_events WHERE shop_id = $1`,
        [shopId],
      );
      expect(events).toEqual([
        {
          event_type: 'shop.opened',
          aggregate_type: 'shop',
          aggregate_id: shopId,
          payload: { handle: 'zari-fashions' },
        },
      ]);
      // Its owner uses it with a second factor.
      expect(await resolver.resolve(tokens.accessToken, shopId)).toEqual({
        ok: false,
        reason: 'mfa_required',
      });
      // The identity login records no other event, and changes no shop.
      const other = await identityDb.app
        .execute(
          sql`insert into platform.outbox_events
                (id, shop_id, aggregate_type, aggregate_id, event_type, payload)
              values (${newId()}, ${shopId}, 'shop', ${shopId}, 'shop.closed', '{}')`,
        )
        .catch((error) => error);
      expect(other.cause?.code ?? other.code).toBe('42501');
      const renamed = await identityDb.app
        .execute(sql`update control.shops set status = 'closed' where id = ${shopId}`)
        .catch((error) => error);
      expect(renamed.cause?.code ?? renamed.code).toBe('42501');
    });

    it('numbers a handle made from the name when another shop has it, and refuses one asked for', async () => {
      const { tokens } = await signUp();
      const session = await auth(tokens.accessToken);
      const first = await service.openShop(session, { name: 'Lawn House' }, client());
      const second = await service.openShop(session, { name: 'Lawn  House!' }, client());
      expect([first.handle, second.handle]).toEqual(['lawn-house', 'lawn-house-2']);
      const taken = await authError(
        service.openShop(session, { name: 'Other', handle: ' Lawn-House ' }, client()),
      );
      expect([taken.code, taken.details.fields]).toEqual([
        'HANDLE_TAKEN',
        { handle: 'Taken by another shop' },
      ]);
      const reserved = await authError(
        service.openShop(session, { name: 'Admin', handle: 'admin' }, client()),
      );
      expect(reserved.details.fields).toEqual({ handle: 'This handle is kept for the platform' });
      const invalid = await authError(
        service.openShop(session, { name: ' ', handle: '-x-' }, client()),
      );
      expect([invalid.code, Object.keys(invalid.details.fields!)]).toEqual([
        'INVALID_INPUT',
        ['name', 'handle'],
      ]);
    });

    it('lets an account own five shops at most', async () => {
      const { tokens } = await signUp();
      const session = await auth(tokens.accessToken);
      for (let shop = 1; shop <= SHOP_LIMITS.ownedShops; shop += 1) {
        await service.openShop(session, { name: `Bazaar ${shop}` }, client());
      }
      const more = await authError(service.openShop(session, { name: 'Bazaar 6' }, client()));
      expect([more.code, more.status]).toEqual(['TOO_MANY_SHOPS', 422]);
    });

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
          actor: { kind: 'staff', userId, role: 'packer', authenticatedAt: expect.any(Date) },
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
        'write_settings',
        'write_themes',
        'write_online_store_navigation',
        'write_online_store_pages',
        'write_domains',
        'write_legal_policies',
        'write_discounts',
        'write_files',
        'write_pixels',
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

  describe('support access (ADR-156)', () => {
    let support: SupportAccessService;
    const grantRole = (userId: string, shopId: string, role: StaffRole) =>
      service.grantMembership({ userId, shopId, role });

    beforeAll(() => {
      support = new SupportAccessService({ db: identityDb.app });
    });

    it("lets Hatti's support look while the owner allows it, reading alone, with a second factor", async () => {
      const shop = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [shop]);
      const owner = await signUpWithTotp();
      await grantRole(owner.userId, shop, 'owner');
      const manager = await signUpWithTotp();
      await grantRole(manager.userId, shop, 'manager');
      const agent = await signUpWithTotp();
      expect(await support.setAgent(agent.email.toUpperCase(), true)).toBe(true);
      expect(await support.setAgent(uniqueEmail(), true)).toBe(false);
      expect(await support.isAgent(agent.userId)).toBe(true);
      expect(await support.isAgent(owner.userId)).toBe(false);

      // Not yet allowed: the agent sees nothing of the shop.
      expect(await resolver.resolve(agent.tokens.accessToken, shop)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      expect(await support.openGrantOf(shop)).toBeNull();
      // The owner alone allows it, for 15 minutes to a day.
      expect((await support.grant({ userId: manager.userId }, shop, {})).ok).toBe(false);
      for (const minutes of [14, 1_441, 30.5]) {
        const refused = await support.grant({ userId: owner.userId }, shop, { minutes });
        expect(refused.ok ? null : refused.errors[0]!.field, String(minutes)).toEqual(['minutes']);
      }
      const before = Date.now();
      const first = await support.grant({ userId: owner.userId }, shop, {
        minutes: 30,
        note: " Order #1043 won't ship ",
      });
      if (!first.ok) throw new Error(JSON.stringify(first.errors));
      const grant = first.value.grant;
      expect(first.value).toMatchObject({
        grant: {
          access: 'read',
          note: "Order #1043 won't ship",
          grantedBy: { userId: owner.userId, name: 'Ayesha Khan' },
          endedAt: null,
          endedBy: null,
          open: true,
        },
        ended: null,
      });
      expect(grant.expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);
      expect(grant.expiresAt.getTime() - before).toBeLessThanOrEqual(30 * 60_000 + 60_000);

      // The agent reads, as support, with every read scope and no write.
      const looking = await resolver.resolve(agent.tokens.accessToken, shop);
      expect(looking).toEqual({
        ok: true,
        tenant: {
          shopId: shop,
          currency: 'PKR',
          scopes: new Set(SUPPORT_SCOPES),
          actor: {
            kind: 'support',
            userId: agent.userId,
            sessionId: expect.any(String),
            grantId: grant.id,
            authenticatedAt: expect.any(Date),
          },
        },
      });
      expect([...SUPPORT_SCOPES].every((scope) => scope.startsWith('read_'))).toBe(true);
      expect(await support.shopsOpenTo(agent.userId)).toEqual([
        {
          shopId: shop,
          name: 'Zari',
          handle: expect.any(String),
          grantId: grant.id,
          note: "Order #1043 won't ship",
          expiresAt: grant.expiresAt,
        },
      ]);
      expect(await support.shopsOpenTo(owner.userId)).toEqual([]);
      // Another shop stays closed to it.
      expect(await resolver.resolve(agent.tokens.accessToken, shopB)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      // An agent who has not proved who they are with a second factor looks at nothing.
      const unproved = await signUp();
      await support.setAgent(unproved.email, true);
      expect(await resolver.resolve(unproved.tokens.accessToken, shop)).toEqual({
        ok: false,
        reason: 'mfa_required',
      });
      // Working in the shop, an agent is its staff there.
      await grantRole(unproved.userId, shop, 'packer');
      const packer = await resolver.resolve(unproved.tokens.accessToken, shop);
      expect(packer.ok && packer.tenant.actor.kind).toBe('staff');

      // Allowed again: the grant open ends, by the owner.
      const second = await support.grant({ userId: owner.userId }, shop, {});
      if (!second.ok) throw new Error(JSON.stringify(second.errors));
      expect(second.value.ended).toMatchObject({
        id: grant.id,
        open: false,
        endedBy: { userId: owner.userId },
      });
      expect(second.value.grant.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
      expect((await support.grantsOf(shop)).map((one) => [one.id, one.open])).toEqual([
        [second.value.grant.id, true],
        [grant.id, false],
      ]);

      // A manager ends it at once: the agent sees nothing more.
      const ended = await support.end({ userId: manager.userId }, shop);
      expect(ended.ok && ended.value).toMatchObject({
        id: second.value.grant.id,
        open: false,
        endedBy: { userId: manager.userId, name: 'Ayesha Khan' },
      });
      expect(await resolver.resolve(agent.tokens.accessToken, shop)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      const again = await support.end({ userId: owner.userId }, shop);
      expect(again.ok ? null : again.errors[0]!.code).toBe('NOT_FOUND');
      // A packer ends nothing.
      expect((await support.end({ userId: unproved.userId }, shop)).ok).toBe(false);
    });

    it('closes the shop when the time is up, or the agent is no longer one', async () => {
      const shop = newId();
      await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Lawn House')`, [shop]);
      const owner = await signUpWithTotp();
      await grantRole(owner.userId, shop, 'owner');
      const agent = await signUpWithTotp();
      await support.setAgent(agent.email, true);
      const first = await support.grant({ userId: owner.userId }, shop, { minutes: 15 });
      if (!first.ok) throw new Error(JSON.stringify(first.errors));
      expect((await resolver.resolve(agent.tokens.accessToken, shop)).ok).toBe(true);

      // Its time up: closed, and recorded as ended then once another grant comes.
      await admin.query(
        `UPDATE identity.support_grants
            SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          WHERE id = $1`,
        [first.value.grant.id],
      );
      expect(await resolver.resolve(agent.tokens.accessToken, shop)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      expect(await support.openGrantOf(shop)).toBeNull();
      expect(await support.shopsOpenTo(agent.userId)).toEqual([]);
      const second = await support.grant({ userId: owner.userId }, shop, {});
      if (!second.ok) throw new Error(JSON.stringify(second.errors));
      expect(second.value.ended).toBeNull();
      const [, expired] = await support.grantsOf(shop);
      expect(expired).toMatchObject({ open: false, endedBy: null });
      expect(expired!.endedAt).toEqual(expired!.expiresAt);
      expect((await resolver.resolve(agent.tokens.accessToken, shop)).ok).toBe(true);

      // No longer one of Hatti's agents: closed, though the owner still allows support.
      await support.setAgent(agent.email, false);
      expect(await resolver.resolve(agent.tokens.accessToken, shop)).toEqual({
        ok: false,
        reason: 'no_shop_access',
      });
      expect(await support.shopsOpenTo(agent.userId)).toEqual([]);
    });
  });
});
