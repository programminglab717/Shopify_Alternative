import { randomBytes, randomInt } from 'node:crypto';
import { SUPPORT_SCOPES, type StaffRole } from '@hatti/api';
import { SecretBox, base32Decode, sha256, totp } from '@hatti/crypto';
import { Database, pgError } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import { RateLimiter } from '@hatti/ratelimit';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { errors as joseErrors } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GoogleTestIssuer,
  SnsTestTopic,
  SoftAuthenticator,
  type GoogleTestClaims,
} from '../testing/index.js';
import {
  AccountEmailSender,
  accountEmail,
  invitationEmail,
  signInAlertEmail,
  type AccountEmail,
} from './account-emails.js';
import {
  EmailFeedbackService,
  liftSuppression,
  suppressionOf,
  type SesSuppressionList,
} from './email-feedback.js';
import { AuthError } from './errors.js';
import {
  IdentityService,
  LIFETIMES,
  type ClientInfo,
  type SignInResult,
} from './identity.service.js';
import { HaveIBeenPwnedChecker, hashPassword, needsRehash } from './passwords.js';
import {
  PhoneCodeSender,
  maskPhone,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
} from './phone-codes.js';
import * as schema from './schema.js';
import { SHOP_LIMITS, handleFrom, handleProblem } from './shops.js';
import { SIGN_IN_ALERT, describeDevice, pakistanTime } from './sign-in-alerts.js';
import { StaffAccessResolver } from './staff-access.js';
import { STAFF_LIMITS, StaffService, ownerEmailIn, staffPhonesIn } from './staff.service.js';
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

describe('account emails (ADR-165)', () => {
  it('writes them in English and Urdu, quoting names and links safely', () => {
    const english = accountEmail('reset_password', {
      to: 'sana@example.pk',
      name: 'Sana <b>Iqbal</b>',
      link: 'https://admin.hatti.pk/reset-password#token=hpr_x&y',
      language: 'en',
    });
    expect(english.subject).toBe('Reset your Hatti password');
    expect(english.text).toBe(
      [
        'Assalam o alaikum Sana <b>Iqbal</b>,',
        'Someone, we hope you, asked to reset the password of your Hatti account. Choose a new one here.',
        'https://admin.hatti.pk/reset-password#token=hpr_x&y',
        "The link works once, for an hour. If it wasn't you, ignore this email: your password stays as it is.",
      ].join('\n\n'),
    );
    expect(english.html).toContain('<p>Assalam o alaikum Sana &lt;b&gt;Iqbal&lt;/b&gt;,</p>');
    expect(english.html).toContain(
      '<a href="https://admin.hatti.pk/reset-password#token=hpr_x&amp;y"',
    );
    expect(english.html).toContain('<html lang="en">');
    const urdu = accountEmail('verify_email', {
      to: 'sana@example.pk',
      name: 'ثناء',
      link: 'https://admin.hatti.pk/verify-email#token=hev_x',
      language: 'ur',
    });
    expect(urdu.subject).toBe('ہٹی کے لیے اپنی ای میل کی تصدیق کریں');
    expect(urdu.text.startsWith('السلام علیکم ثناء،')).toBe(true);
    // Its words right to left; the link, left to right.
    expect(urdu.html).toContain('<html lang="ur" dir="rtl">');
    expect(urdu.html).toContain('<p dir="ltr"');
    // An invitation quotes its inviter and shop on one line each.
    const invitation = invitationEmail({
      to: 'bilal@example.pk',
      inviter: 'Sana\nIqbal',
      shop: 'Zari <Lawn>',
      role: 'accountant',
      link: 'https://admin.hatti.pk/invitation#token=hsi_x',
      language: 'en',
    });
    expect(invitation.subject).toBe('Sana Iqbal invited you to Zari <Lawn> on Hatti');
    expect(invitation.text).toContain(
      'Sana Iqbal invited you to work in Zari <Lawn> on Hatti, as an accountant.',
    );
    expect(invitation.html).toContain('Zari &lt;Lawn&gt;');
  });
});

/** User agents of browsers as they sign in. */
const AGENTS = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  firefoxMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
} as const;

describe('sign-in alerts (ADR-179)', () => {
  it('names the browser and the system a user agent says, in words of their own', () => {
    expect(Object.values(AGENTS).map((agent) => describeDevice(agent, 'en'))).toEqual([
      'Chrome on Windows',
      'Chrome on Android',
      'Safari on iPhone',
      'Chrome on iPhone',
      'Edge on Windows',
      'Samsung Internet on Android',
      'Firefox on Mac',
    ]);
    expect(describeDevice(AGENTS.chromeAndroid, 'ur')).toBe('Android پر Chrome');
    // Nothing of the user agent's own: whoever signs in writes it.
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) <b>Evil</b>', 'en')).toBe(
      'a browser on Windows',
    );
    expect(describeDevice('curl/8.5.0', 'en')).toBe('an unknown device');
    expect(describeDevice(null, 'ur')).toBe('نامعلوم ڈیوائس');
    expect(pakistanTime(new Date('2026-10-05T10:04:00Z'))).toBe('5 Oct, 3:04 pm');
  });

  it('writes its email in English and Urdu, with the internet address where it is known', () => {
    const english = signInAlertEmail({
      to: 'sana@example.pk',
      name: 'Sana\nIqbal',
      device: 'Chrome on Android',
      time: '5 Oct, 3:04 pm',
      ip: '39.45.12.3',
      link: 'https://admin.hatti.pk/',
      language: 'en',
    });
    expect(english.subject).toBe('New sign-in to your Hatti account');
    expect(english.text).toBe(
      [
        'Assalam o alaikum Sana Iqbal,',
        'Your Hatti account was signed in to from Chrome on Android on 5 Oct, 3:04 pm, from the internet address 39.45.12.3.',
        'https://admin.hatti.pk/',
        "If it was you, there's nothing to do. If it wasn't, sign that device out from your sessions in Hatti's admin, change your password if you have one, and contact Hatti's support.",
      ].join('\n\n'),
    );
    const urdu = signInAlertEmail({
      to: 'sana@example.pk',
      name: 'ثناء',
      device: 'Android پر Chrome',
      time: '5 Oct, 3:04 pm',
      ip: null,
      link: 'https://admin.hatti.pk/',
      language: 'ur',
    });
    expect(urdu.subject).toBe('آپ کے ہٹی اکاؤنٹ میں نیا سائن ان');
    expect(urdu.text).toContain(
      'آپ کے ہٹی اکاؤنٹ میں 5 Oct, 3:04 pm کو Android پر Chrome سے سائن ان ہوا۔',
    );
    expect(urdu.html).toContain('<html lang="ur" dir="rtl">');
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
        schema.phoneCodes,
        schema.googleAccounts,
        schema.googleNonces,
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
        googleOptions: null,
        phone: null,
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
        googleOptions: null,
        phone: null,
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

    it('gives the numbers its staff are told of their own work at, where they proved them, to its own transactions alone (ADR-191, ADR-193)', async () => {
      const { shopId, owner } = await shopWithOwner();
      const packer = await signUp();
      const leaving = await signUp();
      await service.grantMembership({ userId: packer.userId, shopId, role: 'packer' });
      await service.grantMembership({ userId: leaving.userId, shopId, role: 'packer' });
      // The packer proved theirs with a code; the owner's waits for one.
      await admin.query(
        'UPDATE identity.users SET phone_e164 = $2, phone_verified_at = now() WHERE id = $1',
        [packer.userId, '+923001112223'],
      );
      await admin.query(
        "UPDATE identity.users SET phone_e164 = $2, language = 'ur' WHERE id = $1",
        [owner.userId, '+923004445556'],
      );
      expect(await staff().remove(owner, shopId, leaving.userId)).toMatchObject({ ok: true });
      // As the worker reads them: in a transaction of the shop's, through identity's function.
      const phonesFrom = (transactionShop: string) =>
        appDb.tenant(transactionShop, (tx) => staffPhonesIn(tx, shopId));
      expect(await phonesFrom(shopId)).toEqual([
        { userId: owner.userId, name: 'Ayesha Khan', phone: null, language: 'ur' },
        { userId: packer.userId, name: 'Ayesha Khan', phone: '+923001112223', language: 'en' },
      ]);
      // A disabled account is told nothing; another shop's transaction learns nothing of them.
      await admin.query("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [
        packer.userId,
      ]);
      expect((await phonesFrom(shopId)).map((member) => member.phone)).toEqual([null, null]);
      expect(await phonesFrom(shopA)).toEqual([]);
      // The app's login reads identity's function, never its tables.
      const denied = await appDb
        .tenant(shopId, (tx) => tx.execute(sql`SELECT phone_e164 FROM identity.users`))
        .catch((error: unknown) => error);
      expect(pgError(denied)?.code).toBe('42501');
    });

    it('gives the shop its owner at the email they proved, in their language, to its own transactions alone (ADR-195)', async () => {
      const { shopId, owner } = await shopWithOwner('Gota');
      const manager = await signUp();
      await service.grantMembership({ userId: manager.userId, shopId, role: 'manager' });
      const ownerFrom = (transactionShop: string) =>
        appDb.tenant(transactionShop, (tx) => ownerEmailIn(tx, shopId));
      const prove = (userId: string) =>
        admin.query('UPDATE identity.users SET email_verified_at = now() WHERE id = $1', [userId]);
      // Not proved yet: none, however proved a manager's is.
      await prove(manager.userId);
      expect(await ownerFrom(shopId)).toBeNull();
      await prove(owner.userId);
      await admin.query("UPDATE identity.users SET language = 'ur' WHERE id = $1", [owner.userId]);
      expect(await ownerFrom(shopId)).toEqual({
        userId: owner.userId,
        name: 'Ayesha Khan',
        email: owner.email,
        language: 'ur',
      });
      // Another shop's transaction learns nothing of them.
      expect(await ownerFrom(shopA)).toBeNull();
      // An address that bounced for good takes no more of Hatti's mail; a disabled account none.
      await admin.query(
        `INSERT INTO identity.email_suppressions (email, reason, feedback_id)
         VALUES ($1, 'bounce', 'test')`,
        [owner.email],
      );
      expect(await ownerFrom(shopId)).toBeNull();
      await admin.query('DELETE FROM identity.email_suppressions WHERE email = $1', [owner.email]);
      await admin.query("UPDATE identity.users SET status = 'disabled' WHERE id = $1", [
        owner.userId,
      ]);
      expect(await ownerFrom(shopId)).toBeNull();
    });

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

    it('emails an invitation where its inviter gives an address, 20 a day for a shop at most (ADR-167)', async () => {
      const { shopId, owner } = await shopWithOwner('Zari Lawn');
      const sent: AccountEmail[] = [];
      let working = true;
      class Outbox extends AccountEmailSender {
        async send(email: AccountEmail): Promise<boolean> {
          if (!working) return false;
          sent.push(email);
          return true;
        }
      }
      const mailing = new StaffService({
        db: identityDb.app,
        now: () => new Date(clock),
        emails: { sender: new Outbox(), adminUrl: 'https://admin.hatti.pk' },
      });
      const invited = await mailing.invite(
        owner,
        shopId,
        { role: 'manager', email: ' Sara@Example.PK ', language: 'ur' },
        client(),
      );
      if (!invited.ok) throw new Error('expected an invitation');
      expect(invited.value).toMatchObject({
        emailed: true,
        invitation: { role: 'manager', email: 'sara@example.pk' },
      });
      expect(sent).toEqual([
        {
          to: 'sara@example.pk',
          subject: 'Ayesha Khan نے آپ کو ہٹی پر Zari Lawn میں بلایا ہے',
          text: expect.stringContaining(
            `https://admin.hatti.pk/invitation#token=${invited.value.token}`,
          ),
          html: expect.stringContaining('dir="rtl"'),
        },
      ]);
      expect(sent[0]!.text).toContain('بطور مینیجر');
      // Its link is whoever holds it's, as one shared by hand.
      expect(await mailing.preview(invited.value.token)).toMatchObject({
        role: 'manager',
        shop: { name: 'Zari Lawn' },
      });

      // An address that is none is refused; without one, nothing is emailed.
      expect(
        errorsOf(await mailing.invite(owner, shopId, { role: 'packer', email: 'sara' }, client())),
      ).toEqual([['email', 'INVALID']]);
      expect(await mailing.invite(owner, shopId, { role: 'packer' }, client())).toMatchObject({
        ok: true,
        value: { emailed: false, invitation: { email: null } },
      });
      // One that could not go leaves the invitation standing, its link the inviter's to share.
      working = false;
      expect(
        await mailing.invite(
          owner,
          shopId,
          { role: 'packer', email: 'imran@example.pk' },
          client(),
        ),
      ).toMatchObject({
        ok: true,
        value: { emailed: false, invitation: { email: 'imran@example.pk' } },
      });
      working = true;
      // Twenty a day: two so far, then 18 more, and none until a day on.
      for (let more = 0; more < 18; more++) {
        await mailing.invite(
          owner,
          shopId,
          { role: 'packer', email: `packer${more}@example.pk` },
          client(),
        );
      }
      const tooMany = await mailing.invite(
        owner,
        shopId,
        { role: 'packer', email: 'one.more@example.pk' },
        client(),
      );
      expect(errorsOf(tooMany)).toEqual([['email', 'TOO_MANY']]);
      clock += 24 * 3_600_000 + 1_000;
      expect(
        await mailing.invite(
          owner,
          shopId,
          { role: 'packer', email: 'one.more@example.pk' },
          client(),
        ),
      ).toMatchObject({ ok: true, value: { emailed: true } });
      expect(sent).toHaveLength(20);
      // Where Hatti sends no email, the invitation stands and says so.
      expect(
        await staff().invite(owner, shopId, { role: 'packer', email: 'x@example.pk' }, client()),
      ).toMatchObject({ ok: true, value: { emailed: false } });
      // Nor to an address that marked an email of Hatti's as spam (ADR-170).
      const topic = new SnsTestTopic();
      const feedback = new EmailFeedbackService({
        db: identityDb.app,
        feedback: { topicArn: topic.topicArn, certificates: topic.certificates },
      });
      expect(
        await feedback.hear(topic.notification(SnsTestTopic.complaint(['Sara@Example.PK']))),
      ).toBe('recorded');
      expect(
        await mailing.invite(owner, shopId, { role: 'packer', email: 'sara@example.pk' }, client()),
      ).toMatchObject({ ok: true, value: { emailed: false } });
      expect(sent).toHaveLength(20);
    });

    it('emails an invitation still waiting again, by a new link in place of the old (ADR-196)', async () => {
      const { shopId, owner } = await shopWithOwner('Resham');
      const manager = await signUp();
      await service.grantMembership({ userId: manager.userId, shopId, role: 'manager' });
      const sent: AccountEmail[] = [];
      class Outbox extends AccountEmailSender {
        async send(email: AccountEmail): Promise<boolean> {
          sent.push(email);
          return true;
        }
      }
      const mailing = new StaffService({
        db: identityDb.app,
        now: () => new Date(clock),
        emails: { sender: new Outbox(), adminUrl: 'https://admin.hatti.pk' },
      });
      const invited = await mailing.invite(
        owner,
        shopId,
        { role: 'packer', note: 'Bilal, packing', email: 'bilal@example.pk' },
        client(),
      );
      if (!invited.ok) throw new Error('expected an invitation');
      const before = invited.value;

      // A day on, it went astray: the manager sends it again, in Urdu, their own language.
      clock += 24 * 3_600_000;
      await admin.query("UPDATE identity.users SET language = 'ur' WHERE id = $1", [
        manager.userId,
      ]);
      const resent = await mailing.resendInvitation(
        manager,
        shopId,
        before.invitation.id,
        {},
        client(),
      );
      if (!resent.ok) throw new Error('expected it sent again');
      const after = resent.value;
      expect(after).toEqual({
        invitation: {
          id: expect.any(String),
          role: 'packer',
          note: 'Bilal, packing',
          email: 'bilal@example.pk',
          invitedBy: { userId: manager.userId, name: 'Ayesha Khan' },
          createdAt: new Date(clock),
          expiresAt: new Date(clock + STAFF_LIMITS.invitationMs),
        },
        token: expect.stringMatching(/^hsi_/),
        emailed: true,
        replaced: before.invitation.id,
      });
      expect(after.invitation.id).not.toBe(before.invitation.id);
      expect(sent.at(-1)).toMatchObject({
        to: 'bilal@example.pk',
        text: expect.stringContaining(`https://admin.hatti.pk/invitation#token=${after.token}`),
        html: expect.stringContaining('dir="rtl"'),
      });
      // The link before opens nothing; the shop waits on the new one alone.
      expect(await mailing.preview(before.token)).toBeNull();
      expect(await mailing.preview(after.token)).toMatchObject({ role: 'packer' });
      expect((await mailing.invitationsOf(shopId)).map((each) => each.id)).toEqual([
        after.invitation.id,
      ]);
      const { rows: recorded } = await admin.query<{ kind: string }>(
        'SELECT kind FROM identity.auth_events WHERE user_id = $1',
        [manager.userId],
      );
      expect(recorded.map((row) => row.kind)).toEqual(['sign_up', 'staff_invitation_resent']);

      // Gone, taken back, accepted or without an address, it is not sent again.
      const again = (id: string, who: { userId: string } = owner) =>
        mailing.resendInvitation(who, shopId, id, { language: 'en' }, client());
      expect(errorsOf(await again(before.invitation.id))).toEqual([['id', 'NOT_FOUND']]);
      const unaddressed = await mailing.invite(owner, shopId, { role: 'packer' }, client());
      if (!unaddressed.ok) throw new Error('expected an invitation');
      expect(messageOf(await again(unaddressed.value.invitation.id))).toBe(
        'It has no email address: share its link instead',
      );
      const packer = await signUp();
      await service.grantMembership({ userId: packer.userId, shopId, role: 'packer' });
      expect(errorsOf(await again(after.invitation.id, packer))).toEqual([['id', 'INVALID']]);
      clock += STAFF_LIMITS.invitationMs;
      expect(messageOf(await again(after.invitation.id))).toBe('It has expired: invite them again');
      // Twenty emailed a day for the shop, those sent again among them.
      clock += 1_000;
      let last = await mailing.invite(
        owner,
        shopId,
        { role: 'packer', email: 'imran@example.pk' },
        client(),
      );
      for (let more = 0; more < 19 && last.ok; more++) {
        last = await again(last.value.invitation.id);
      }
      expect(last.ok).toBe(true);
      if (!last.ok) throw new Error('expected an invitation');
      expect(errorsOf(await again(last.value.invitation.id))).toEqual([['id', 'TOO_MANY']]);
      // Refused, it stands as it was.
      expect(await mailing.preview(last.value.token)).toMatchObject({ role: 'packer' });
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
        email: null,
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
        'write_content',
        'write_domains',
        'write_legal_policies',
        'write_discounts',
        'write_files',
        'write_pixels',
        'read_store_credit_accounts',
        'write_store_credit_account_transactions',
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

  describe('phone sign-up (ADR-159)', () => {
    /** Sends codes nowhere, keeping each; by the channel asked, unless told otherwise. */
    class CodesSent extends PhoneCodeSender {
      readonly sent: {
        phone: string;
        code: string;
        channel: PhoneCodeChannel;
        language: PhoneCodeLanguage;
      }[] = [];
      answer: PhoneCodeChannel | null | 'asked' = 'asked';

      async send(input: {
        phone: string;
        code: string;
        channel: PhoneCodeChannel;
        language: PhoneCodeLanguage;
      }): Promise<PhoneCodeChannel | null> {
        if (this.answer === null) return null;
        const channel = this.answer === 'asked' ? input.channel : this.answer;
        this.sent.push({ ...input, channel });
        return channel;
      }

      get last(): string {
        return this.sent.at(-1)!.code;
      }

      /** The numbers told another took their place (ADR-173). */
      readonly replaced: { phone: string; replacedBy: string; language: PhoneCodeLanguage }[] = [];

      override async tellReplaced(input: {
        phone: string;
        replacedBy: string;
        language: PhoneCodeLanguage;
      }): Promise<PhoneCodeChannel | null> {
        this.replaced.push(input);
        return 'whatsapp';
      }

      /** The numbers told they were removed from their accounts (ADR-202). */
      readonly removed: { phone: string; language: PhoneCodeLanguage }[] = [];

      override async tellRemoved(input: {
        phone: string;
        language: PhoneCodeLanguage;
      }): Promise<PhoneCodeChannel | null> {
        this.removed.push(input);
        return 'whatsapp';
      }
    }

    let codes: CodesSent;
    let phones: IdentityService;
    /** A mobile number no test has used: as typed, and in E.164. */
    const newNumber = () => {
      const digits = String(randomInt(0, 10_000_000)).padStart(7, '0');
      const network = `3${randomInt(0, 5)}${randomInt(0, 10)}`;
      return { typed: `0${network} ${digits}`, e164: `+92${network}${digits}` };
    };
    /** Half a minute on: a number may be sent another code. */
    const later = () => (clock += 31_000);
    /** A code not `code`: its last digit another. */
    const wrongFor = (code: string) => `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;
    const events = async (userId: string) =>
      (
        await admin.query<{ kind: string }>(
          'SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id',
          [userId],
        )
      ).rows.map((row) => row.kind);

    beforeAll(() => {
      codes = new CodesSent();
      phones = new IdentityService({
        db: identityDb.app,
        secretBox,
        rateLimiter: new RateLimiter(redis, `${rateLimitPrefix}-phones`),
        passkeys: PASSKEYS,
        phoneCodes: codes,
        now: () => new Date(clock),
      });
    });

    it('confirms who is at an account with no second factor by a code to its number, or Google where it is connected (ADR-201)', async () => {
      const issuer = await GoogleTestIssuer.create();
      const both = new IdentityService({
        db: identityDb.app,
        secretBox,
        rateLimiter: new RateLimiter(redis, `${rateLimitPrefix}-reauthenticate`),
        passkeys: PASSKEYS,
        phoneCodes: codes,
        google: { clientIds: [issuer.clientId], keys: issuer.keys },
        now: () => new Date(clock),
      });
      /** The session as it is when its user last proved who they are 20 minutes ago. */
      const stale = async (accessToken: string) => {
        const session = await auth(accessToken);
        await admin.query(
          `UPDATE identity.sessions SET authenticated_at = authenticated_at - interval '20 minutes'
            WHERE id = $1`,
          [session.sessionId],
        );
        return auth(accessToken);
      };
      const number = newNumber();
      await both.sendPhoneCode({ phone: number.typed }, client());
      const proved = await both.phoneSignIn({ phone: number.typed, code: codes.last }, client());
      if (proved.status !== 'sign_up_required') throw new Error('Expected a sign-up');
      const opened = await both.phoneSignUp(
        { signUpToken: proved.signUpToken, name: 'Nadia Hussain' },
        client(),
      );
      let session = await stale(opened.tokens.accessToken);

      // Its number is its only way in, and a code to it confirms who is at it.
      expect(await both.reauthenticationOptions(session)).toEqual({
        methods: ['phone'],
        passkeyOptions: null,
        googleOptions: null,
        phone: maskPhone(number.e164),
      });
      expect(
        await authError(both.reauthenticate(session, { password: PASSWORD }, client())),
      ).toMatchObject({
        code: 'INVALID_METHOD',
        message:
          'Confirm with a code sent to your number: your account has no passkey or authenticator app',
      });
      later();
      expect(
        await both.sendReauthenticationCode(session, { channel: 'sms' }, client()),
      ).toMatchObject({ phone: maskPhone(number.e164), channel: 'sms' });
      expect(codes.sent.at(-1)).toMatchObject({ phone: number.e164, channel: 'sms' });
      // A wrong code is refused, never as a session that is no more.
      expect(
        await authError(
          both.reauthenticate(session, { phoneCode: wrongFor(codes.last) }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_CODE', status: 422 });
      const sent = codes.last;
      expect(await both.reauthenticate(session, { phoneCode: sent }, client())).toEqual({
        authenticatedAt: new Date(clock),
        sensitiveActionsUntil: new Date(clock + 15 * 60_000),
      });
      expect(await auth(opened.tokens.accessToken)).toMatchObject({
        authenticatedAt: new Date(clock),
        mfaVerified: false,
      });
      // A code confirms once.
      expect(
        await authError(both.reauthenticate(session, { phoneCode: sent }, client())),
      ).toMatchObject({ code: 'INVALID_CODE' });

      // With Google connected, Google's sign-in confirms it too: the Google account connected,
      // with the nonce the options gave, once.
      const subject = `3${String(randomInt(0, 2 ** 47)).padStart(20, '0')}`;
      const { nonce } = await both.googleOptions(client());
      await both.connectGoogle(
        await auth(opened.tokens.accessToken),
        {
          idToken: await issuer.idToken(
            { sub: subject, nonce, email: uniqueEmail(), email_verified: true },
            { at: new Date(clock) },
          ),
        },
        client(),
      );
      session = await stale(opened.tokens.accessToken);
      const options = await both.reauthenticationOptions(session);
      expect(options).toMatchObject({
        methods: ['google', 'phone'],
        googleOptions: { clientId: issuer.clientId, nonce: expect.any(String) },
      });
      const fromGoogle = (sub: string, withNonce = options.googleOptions!.nonce) =>
        issuer.idToken({ sub, nonce: withNonce }, { at: new Date(clock) });
      // Another Google account, or a nonce this API never gave, confirms nothing.
      expect(
        await authError(
          both.reauthenticate(
            session,
            { googleIdToken: await fromGoogle(`4${subject}`) },
            client(),
          ),
        ),
      ).toMatchObject({ code: 'INVALID_GOOGLE_SIGN_IN', status: 422 });
      const again = await both.reauthenticationOptions(session);
      expect(
        await authError(
          both.reauthenticate(
            session,
            { googleIdToken: await fromGoogle(subject, 'not-a-nonce-of-ours') },
            client(),
          ),
        ),
      ).toMatchObject({ code: 'INVALID_GOOGLE_SIGN_IN' });
      const own = await fromGoogle(subject, again.googleOptions!.nonce);
      await both.reauthenticate(session, { googleIdToken: own }, client());
      expect(await auth(opened.tokens.accessToken)).toMatchObject({
        authenticatedAt: new Date(clock),
        mfaVerified: false,
      });
      expect(
        await authError(both.reauthenticate(session, { googleIdToken: own }, client())),
      ).toMatchObject({ code: 'INVALID_GOOGLE_SIGN_IN' });

      // Once the account has a second factor, that alone confirms it.
      const fresh = await auth(opened.tokens.accessToken);
      const { secret } = await both.setUpTotp(fresh);
      await both.confirmTotp(fresh, code(secret), client());
      session = await stale(opened.tokens.accessToken);
      expect((await both.reauthenticationOptions(session)).methods).toEqual(['totp']);
      later();
      for (const refused of [
        both.sendReauthenticationCode(session, {}, client()),
        both.reauthenticate(session, { googleIdToken: own }, client()),
      ]) {
        expect(await authError(refused)).toMatchObject({
          code: 'INVALID_METHOD',
          message: 'Confirm with your passkey or authenticator app: your account has one',
        });
      }
    });

    it('takes a number off an account with another way in: it signs in to nothing then, and is told (ADR-202)', async () => {
      // An account opened with an email and a password, in Urdu, proves a number.
      const account = await phones.signUp(
        { email: uniqueEmail(), password: PASSWORD, name: 'Hina Raza', language: 'ur' },
        client(),
      );
      const session = await auth(account.tokens.accessToken);
      const number = newNumber();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      await phones.addPhone(session, { phone: number.typed, code: codes.last }, client());
      // Only from a session proved lately.
      expect(
        await authError(
          phones.removePhone(
            { ...session, authenticatedAt: new Date(clock - 16 * 60_000) },
            client(),
          ),
        ),
      ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED', status: 403 });
      const removed = await phones.removePhone(session, client());
      expect(removed.user).toMatchObject({ phone: null, phoneVerified: false });
      expect(codes.removed.at(-1)).toEqual({ phone: number.e164, language: 'ur' });
      expect((await events(session.userId)).at(-1)).toBe('phone_removed');
      // It signs in to nothing now: whoever proves it opens an account with it.
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(
        await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client()),
      ).toMatchObject({ status: 'sign_up_required' });
      expect(await authError(phones.removePhone(session, client()))).toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });

      // An account its number alone signs in to keeps it, and nothing is told.
      const solo = newNumber();
      await phones.sendPhoneCode({ phone: solo.typed }, client());
      const proved = await phones.phoneSignIn({ phone: solo.typed, code: codes.last }, client());
      if (proved.status !== 'sign_up_required') throw new Error('Expected a sign-up');
      const opened = await phones.phoneSignUp(
        { signUpToken: proved.signUpToken, name: 'Asif Ali' },
        client(),
      );
      const told = codes.removed.length;
      expect(
        await authError(phones.removePhone(await auth(opened.tokens.accessToken), client())),
      ).toMatchObject({ code: 'ONLY_SIGN_IN_METHOD', status: 409 });
      expect(codes.removed).toHaveLength(told);
    });

    it('sends a code to a Pakistani mobile, the last one alone working, and waits between them', async () => {
      const number = newNumber();
      const sent = await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(sent).toEqual({
        phone: `+92 ${number.e164.slice(3, 6)} •••${number.e164.slice(-4)}`,
        channel: 'whatsapp',
        expiresAt: new Date(clock + 10 * 60_000),
        resendAfter: new Date(clock + 30_000),
      });
      expect(codes.sent.at(-1)).toEqual({
        phone: number.e164,
        code: expect.stringMatching(/^\d{6}$/),
        channel: 'whatsapp',
        language: 'en',
      });
      const first = codes.last;
      // Not again so soon, nor to a number not a Pakistani mobile.
      expect(
        await authError(phones.sendPhoneCode({ phone: number.typed }, client())),
      ).toMatchObject({ code: 'TOO_SOON', status: 429, details: { retryAfterMs: 30_000 } });
      for (const phone of ['+44 7700 900123', '042 35761234', 'not a number']) {
        expect(await authError(phones.sendPhoneCode({ phone }, client()))).toMatchObject({
          code: 'INVALID_INPUT',
          details: { fields: { phone: 'Enter a Pakistani mobile number like 0300 1234567' } },
        });
      }
      // By SMS when asked, in Urdu.
      later();
      await phones.sendPhoneCode({ phone: number.e164, channel: 'sms', language: 'ur' }, client());
      expect(codes.sent.at(-1)).toMatchObject({ channel: 'sms', language: 'ur' });
      // The first code no longer works: the last sent alone.
      expect(
        await authError(phones.phoneSignIn({ phone: number.typed, code: first }, client())),
      ).toMatchObject({ code: 'INVALID_CODE', status: 401 });
      // What the sender could not send counts against nothing.
      later();
      codes.answer = null;
      expect(
        await authError(phones.sendPhoneCode({ phone: number.typed }, client())),
      ).toMatchObject({ code: 'CODE_NOT_SENT', status: 503 });
      codes.answer = 'sms';
      expect((await phones.sendPhoneCode({ phone: number.typed }, client())).channel).toBe('sms');
      codes.answer = 'asked';
      // Five an hour to a number.
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      later();
      expect(
        await authError(phones.sendPhoneCode({ phone: number.typed }, client())),
      ).toMatchObject({ code: 'TOO_MANY_CODES', status: 429 });
      // Asked for many times at once, a number is sent one code.
      const busy = newNumber();
      // Connections open for each, so none waits on another's.
      await Promise.all(
        Array.from({ length: 5 }, () => identityDb.app.execute(sql`SELECT pg_sleep(0.02)`)),
      );
      const asked = await Promise.allSettled(
        Array.from({ length: 5 }, () => phones.sendPhoneCode({ phone: busy.typed }, client())),
      );
      expect(asked.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of asked) {
        if (outcome.status === 'rejected')
          expect(outcome.reason).toMatchObject({ code: 'TOO_SOON' });
      }
      // Without a sender, no one signs in by phone.
      expect(
        await authError(service.sendPhoneCode({ phone: number.typed }, client())),
      ).toMatchObject({ code: 'PHONE_SIGN_IN_UNAVAILABLE', status: 503 });
    });

    it('opens an account with a number proved, then signs it in with a code, after its second factor', async () => {
      const number = newNumber();
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(
        await authError(
          phones.phoneSignIn({ phone: number.typed, code: wrongFor(codes.last) }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_CODE' });
      const proved = await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client());
      expect(proved).toEqual({
        status: 'sign_up_required',
        signUpToken: expect.stringMatching(/^hsu_/),
        signUpTokenExpiresAt: new Date(clock + 15 * 60_000),
        phone: expect.stringMatching(/^\+92 3\d\d •••\d{4}$/),
      });
      if (proved.status !== 'sign_up_required') throw new Error('Expected a sign-up');
      // A code works once.
      expect(
        await authError(phones.phoneSignIn({ phone: number.typed, code: codes.last }, client())),
      ).toMatchObject({ code: 'INVALID_CODE' });
      expect(
        await authError(
          phones.phoneSignUp({ signUpToken: proved.signUpToken, name: ' ' }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_INPUT', details: { fields: { name: 'Enter your name' } } });
      // In Urdu, which Hatti's words to him are in from then on (ADR-194).
      const opened = await phones.phoneSignUp(
        { signUpToken: proved.signUpToken, name: 'Bilal Ahmed', language: 'ur' },
        client(),
      );
      expect(opened.user).toEqual({
        id: expect.stringMatching(/^usr_/),
        language: 'ur',
        email: null,
        emailVerified: false,
        name: 'Bilal Ahmed',
        phone: number.e164,
        phoneVerified: true,
        mfaEnabled: false,
      });
      expect((await auth(opened.tokens.accessToken)).userId).toBe(opened.userId);
      expect(
        await authError(
          phones.phoneSignUp({ signUpToken: proved.signUpToken, name: 'Again' }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_SIGN_UP', status: 401 });

      // Without a password or a second factor, a code to its number confirms it is them
      // (ADR-201).
      const session = await auth(opened.tokens.accessToken);
      expect(await phones.reauthenticationOptions(session)).toEqual({
        methods: ['phone'],
        passkeyOptions: null,
        googleOptions: null,
        phone: maskPhone(number.e164),
      });
      expect(
        await authError(phones.reauthenticate(session, { password: PASSWORD }, client())),
      ).toMatchObject({
        code: 'INVALID_METHOD',
        message:
          'Confirm with a code sent to your number: your account has no passkey or authenticator app',
      });

      // Signed in again by phone: the same account.
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      const again = await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client());
      expect(again).toMatchObject({ status: 'signed_in', user: { id: opened.user.id } });

      // With an authenticator app, a code to the number is its first factor alone.
      const { secret } = await phones.setUpTotp(session);
      await phones.confirmTotp(session, code(secret), client());
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      const challenged = await phones.phoneSignIn(
        { phone: number.typed, code: codes.last },
        client(),
      );
      expect(challenged).toMatchObject({
        status: 'mfa_required',
        methods: ['totp', 'recovery_code'],
      });
      if (challenged.status !== 'mfa_required') throw new Error('Expected a challenge');
      clock += 30_000;
      const done = await phones.completeSignIn(
        { challengeToken: challenged.challengeToken, code: code(secret) },
        client(),
      );
      expect(done.user).toMatchObject({ id: opened.user.id, mfaEnabled: true });
      expect(await events(opened.userId)).toEqual([
        'sign_up',
        'sign_in_with_phone',
        'two_step_enabled',
        'sign_in',
      ]);
    });

    it("keeps a number to one account, never signing in to one whose number wasn't proved", async () => {
      const number = newNumber();
      // An account whose owner typed the number at sign-up, unproved.
      const typedIt = await service.signUp(
        { email: uniqueEmail(), password: PASSWORD, name: 'Sana Iqbal', phone: number.typed },
        client(),
      );
      expect(typedIt.user).toMatchObject({ phone: number.e164, phoneVerified: false });
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      const first = await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client());
      expect(first.status).toBe('sign_up_required');
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      const second = await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client());
      if (first.status !== 'sign_up_required' || second.status !== 'sign_up_required') {
        throw new Error('Expected sign-ups');
      }
      const email = uniqueEmail();
      // An email already registered is refused, the number's token kept for another try.
      expect(
        await authError(
          phones.phoneSignUp(
            { signUpToken: first.signUpToken, name: 'Usman Tariq', email: typedIt.user.email },
            client(),
          ),
        ),
      ).toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
      const opened = await phones.phoneSignUp(
        { signUpToken: first.signUpToken, name: 'Usman Tariq', email: ` ${email.toUpperCase()} ` },
        client(),
      );
      expect(opened.user).toMatchObject({ email, phone: number.e164, phoneVerified: true });
      // The number is that account's now: another token for it opens nothing.
      expect(
        await authError(
          phones.phoneSignUp({ signUpToken: second.signUpToken, name: 'Usman Tariq' }, client()),
        ),
      ).toMatchObject({ code: 'PHONE_TAKEN', status: 409 });
    });

    it('proves a number for an account opened with an email, in place of the one typed or proved before', async () => {
      const number = newNumber();
      const account = await phones.signUp(
        { email: uniqueEmail(), password: PASSWORD, name: 'Hamza Ali', phone: number.typed },
        client(),
      );
      expect(account.user).toMatchObject({ phone: number.e164, phoneVerified: false });
      const session = await auth(account.tokens.accessToken);
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(
        await authError(
          phones.addPhone(session, { phone: number.typed, code: wrongFor(codes.last) }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_CODE' });
      const added = await phones.addPhone(
        session,
        { phone: number.typed, code: codes.last },
        client(),
      );
      expect(added.user).toMatchObject({
        id: account.user.id,
        phone: number.e164,
        phoneVerified: true,
      });
      // From then on the number signs the account in. Only typed before, nothing was told.
      expect(codes.replaced).toEqual([]);
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(
        await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client()),
      ).toMatchObject({ status: 'signed_in', user: { id: account.user.id } });

      // Another number in its place: the first signs in to no account now, and is told so, once.
      const other = newNumber();
      later();
      await phones.sendPhoneCode({ phone: other.typed }, client());
      await phones.addPhone(
        session,
        { phone: other.typed, code: codes.last, language: 'ur' },
        client(),
      );
      expect(codes.replaced).toEqual([
        { phone: number.e164, replacedBy: maskPhone(other.e164), language: 'ur' },
      ]);
      later();
      await phones.sendPhoneCode({ phone: other.typed }, client());
      await phones.addPhone(session, { phone: other.typed, code: codes.last }, client());
      expect(codes.replaced).toHaveLength(1);
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      expect(
        await phones.phoneSignIn({ phone: number.typed, code: codes.last }, client()),
      ).toMatchObject({ status: 'sign_up_required' });

      // A number another account proved stays its own.
      const someoneElse = await phones.signUp(
        { email: uniqueEmail(), password: PASSWORD, name: 'Faraz Butt' },
        client(),
      );
      later();
      await phones.sendPhoneCode({ phone: other.typed }, client());
      expect(
        await authError(
          phones.addPhone(
            await auth(someoneElse.tokens.accessToken),
            { phone: other.typed, code: codes.last },
            client(),
          ),
        ),
      ).toMatchObject({ code: 'PHONE_TAKEN', status: 409 });
      // Nor does a session not proved lately change it.
      clock += 15 * 60_000;
      expect(
        await authError(phones.addPhone(session, { phone: other.typed, code: '000000' }, client())),
      ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED', status: 403 });
      expect(await events(account.userId)).toEqual([
        'sign_up',
        'phone_verified',
        'sign_in_with_phone',
        'phone_verified',
      ]);
    });

    it('takes five tries at a code, for ten minutes', async () => {
      const number = newNumber();
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      // Typed with a space, as some do.
      const wrong = wrongFor(codes.last).replace(/^(\d{3})/, '$1 ');
      for (let attempt = 1; attempt < 5; attempt++) {
        expect(
          await authError(phones.phoneSignIn({ phone: number.typed, code: wrong }, client())),
        ).toMatchObject({ code: 'INVALID_CODE' });
      }
      expect(
        await authError(phones.phoneSignIn({ phone: number.typed, code: 'abc' }, client())),
      ).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', status: 429 });
      expect(
        await authError(phones.phoneSignIn({ phone: number.typed, code: codes.last }, client())),
      ).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
      later();
      await phones.sendPhoneCode({ phone: number.typed }, client());
      clock += 10 * 60_000;
      expect(
        await authError(phones.phoneSignIn({ phone: number.typed, code: codes.last }, client())),
      ).toMatchObject({ code: 'CODE_EXPIRED', status: 401 });
    });
  });

  describe('Google sign-in (ADR-164)', () => {
    const ANDROID_CLIENT_ID = '123456789012-hatti-android.apps.googleusercontent.com';
    let issuer: GoogleTestIssuer;
    let googles: IdentityService;
    /** An ID Google has given no account in these tests: digits, as Google's are. */
    const newSubject = () => `1${String(randomInt(0, 2 ** 47)).padStart(20, '0')}`;
    const events = async (userId: string) =>
      (
        await admin.query<{ kind: string }>(
          'SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id',
          [userId],
        )
      ).rows.map((row) => row.kind);
    /** Starts a sign-in with Google, which comes back with its ID token saying `claims`. */
    const fromGoogle = async (
      claims: Omit<GoogleTestClaims, 'nonce'>,
      options: { at?: Date; signedBy?: GoogleTestIssuer } = {},
    ) => {
      const { nonce } = await googles.googleOptions(client());
      return {
        idToken: await issuer.idToken({ ...claims, nonce }, { at: new Date(clock), ...options }),
      };
    };
    const signedIn = (result: SignInResult) => {
      if (result.status !== 'signed_in') throw new Error('Expected to be signed in');
      return result;
    };

    beforeAll(async () => {
      issuer = await GoogleTestIssuer.create();
      googles = new IdentityService({
        db: identityDb.app,
        secretBox,
        rateLimiter: new RateLimiter(redis, `${rateLimitPrefix}-google`),
        passkeys: PASSKEYS,
        google: { clientIds: [issuer.clientId, ANDROID_CLIENT_ID], keys: issuer.keys },
        now: () => new Date(clock),
      });
    });

    it("opens an account with Google's name and the email it confirmed, then signs it in, after its second factor", async () => {
      const started = await googles.googleOptions(client());
      expect(started).toEqual({
        clientId: issuer.clientId,
        nonce: expect.stringMatching(/^[\w-]{43}$/),
        expiresAt: new Date(clock + 10 * 60_000),
      });
      const subject = newSubject();
      const email = uniqueEmail();
      const idToken = await issuer.idToken(
        {
          sub: subject,
          nonce: started.nonce,
          email: email.toUpperCase(),
          email_verified: true,
          name: '  Hira   Baig ',
        },
        { at: new Date(clock) },
      );
      const opened = await googles.signInWithGoogle({ idToken }, client());
      expect(opened).toEqual({
        status: 'signed_in',
        signedUp: true,
        user: {
          id: expect.stringMatching(/^usr_/),
          language: 'en',
          email,
          emailVerified: true,
          name: 'Hira Baig',
          phone: null,
          phoneVerified: false,
          mfaEnabled: false,
        },
        tokens: expect.objectContaining({ accessToken: expect.stringMatching(/^hsa_/) }),
      });
      const session = await auth(signedIn(opened).tokens.accessToken);
      expect((await googles.me(session)).google).toEqual({ email, connectedAt: new Date(clock) });
      const [user] = (
        await admin.query<{ email_verified_at: Date }>(
          'SELECT email_verified_at FROM identity.users WHERE id = $1',
          [session.userId],
        )
      ).rows;
      expect(user!.email_verified_at).toEqual(new Date(clock));
      // A nonce answers once.
      expect(await authError(googles.signInWithGoogle({ idToken }, client()))).toMatchObject({
        code: 'INVALID_CHALLENGE',
        status: 401,
      });

      // Signed in again, from the Android app too: the same account, its email at Google kept as
      // Google says it now.
      clock += 60_000;
      const again = await googles.signInWithGoogle(
        await fromGoogle({ sub: subject, email: 'hira.baig@example.pk', email_verified: 'true' }),
        client(),
      );
      expect(again).toMatchObject({
        status: 'signed_in',
        signedUp: false,
        user: { id: signedIn(opened).user.id, email },
      });
      const android = await googles.signInWithGoogle(
        await fromGoogle({ sub: subject, aud: ANDROID_CLIENT_ID }),
        client(),
      );
      expect(android).toMatchObject({
        status: 'signed_in',
        user: { id: signedIn(opened).user.id },
      });
      expect((await googles.me(session)).google).toEqual({
        email: 'hira.baig@example.pk',
        connectedAt: new Date(clock - 60_000),
      });

      // With an authenticator app, Google is its first factor alone.
      const { secret } = await googles.setUpTotp(session);
      await googles.confirmTotp(session, code(secret), client());
      clock += 30_000;
      const challenged = await googles.signInWithGoogle(
        await fromGoogle({ sub: subject }),
        client(),
      );
      expect(challenged).toMatchObject({
        status: 'mfa_required',
        methods: ['totp', 'recovery_code'],
        signedUp: false,
      });
      if (challenged.status !== 'mfa_required') throw new Error('Expected a challenge');
      const done = await googles.completeSignIn(
        { challengeToken: challenged.challengeToken, code: code(secret) },
        client(),
      );
      expect(done.user).toMatchObject({ id: signedIn(opened).user.id, mfaEnabled: true });
      expect(await events(session.userId)).toEqual([
        'sign_up_with_google',
        'sign_in_with_google',
        'sign_in_with_google',
        'two_step_enabled',
        'sign_in',
      ]);

      // A disabled account signs in no more.
      await admin.query(`UPDATE identity.users SET status = 'disabled' WHERE id = $1`, [
        session.userId,
      ]);
      expect(
        await authError(googles.signInWithGoogle(await fromGoogle({ sub: subject }), client())),
      ).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    });

    it("refuses tokens that are not Google's for Hatti, or not for a sign-in it started", async () => {
      const subject = newSubject();
      const claims = { sub: subject, email: uniqueEmail(), email_verified: true };
      const forger = await GoogleTestIssuer.create(issuer.clientId);
      const at = Math.floor(clock / 1000);
      const unsigned = [
        { alg: 'none', typ: 'JWT' },
        {
          ...claims,
          iss: 'https://accounts.google.com',
          aud: issuer.clientId,
          iat: at,
          exp: at + 3_600,
        },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
        .join('.');
      const refused: [string, { idToken: string }][] = [
        [
          'for another app',
          await fromGoogle({ ...claims, aud: 'other.apps.googleusercontent.com' }),
        ],
        [
          'from another issuer',
          await fromGoogle({ ...claims, iss: 'https://accounts.example.com' }),
        ],
        ['signed with another key', await fromGoogle(claims, { signedBy: forger })],
        ['expired', await fromGoogle(claims, { at: new Date(clock - 3_700_000) })],
        ['unsigned', { idToken: `${unsigned}.` }],
        ['not a token', { idToken: 'not.a.token' }],
        // Without a nonce: a token from a sign-in this API did not start.
        ['without a nonce', { idToken: await issuer.idToken(claims, { at: new Date(clock) }) }],
      ];
      for (const [why, input] of refused) {
        expect(await authError(googles.signInWithGoogle(input, client())), why).toMatchObject({
          code: 'INVALID_GOOGLE_SIGN_IN',
          status: 401,
        });
      }
      // A nonce this API never gave, or gave over ten minutes ago.
      const unknown = await issuer.idToken(
        { ...claims, nonce: randomBytes(32).toString('base64url') },
        { at: new Date(clock) },
      );
      expect(
        await authError(googles.signInWithGoogle({ idToken: unknown }, client())),
      ).toMatchObject({ code: 'INVALID_CHALLENGE', status: 401 });
      const { nonce } = await googles.googleOptions(client());
      clock += 10 * 60_000;
      const late = await issuer.idToken({ ...claims, nonce }, { at: new Date(clock) });
      expect(await authError(googles.signInWithGoogle({ idToken: late }, client()))).toMatchObject({
        code: 'INVALID_CHALLENGE',
      });
      expect(
        (await admin.query('SELECT 1 FROM identity.google_accounts WHERE subject = $1', [subject]))
          .rowCount,
      ).toBe(0);

      // Where Google's keys cannot be had, nothing is refused for good: try again.
      for (const failure of [new TypeError('fetch failed'), new joseErrors.JWKSTimeout()]) {
        const offline = new IdentityService({
          db: identityDb.app,
          secretBox,
          google: {
            clientIds: [issuer.clientId],
            keys: async () => {
              throw failure;
            },
          },
          now: () => new Date(clock),
        });
        const { nonce: fresh } = await offline.googleOptions(client());
        const idToken = await issuer.idToken({ ...claims, nonce: fresh }, { at: new Date(clock) });
        expect(await authError(offline.signInWithGoogle({ idToken }, client()))).toMatchObject({
          code: 'GOOGLE_UNREACHABLE',
          status: 503,
        });
      }
      // Nor anything without Hatti's client IDs.
      expect(await authError(service.googleOptions(client()))).toMatchObject({
        code: 'GOOGLE_SIGN_IN_UNAVAILABLE',
        status: 503,
      });
    });

    it('never connects a Google account to an account by its email: its owner connects it, signed in', async () => {
      const owner = await signUp();
      const subject = newSubject();
      const theirs = { sub: subject, email: owner.email, email_verified: true };
      expect(
        await authError(googles.signInWithGoogle(await fromGoogle(theirs), client())),
      ).toMatchObject({ code: 'GOOGLE_NOT_CONNECTED', status: 409 });
      // An email Google has not confirmed opens nothing.
      const unconfirmed = { sub: newSubject(), email: uniqueEmail(), email_verified: false };
      expect(
        await authError(googles.signInWithGoogle(await fromGoogle(unconfirmed), client())),
      ).toMatchObject({ code: 'GOOGLE_EMAIL_UNCONFIRMED', status: 422 });

      const session = await auth(owner.tokens.accessToken);
      const connected = await googles.connectGoogle(
        session,
        await fromGoogle({ ...theirs, email: owner.email.toUpperCase() }),
        client(),
      );
      expect(connected).toEqual({ email: owner.email, connectedAt: new Date(clock) });
      // The same again changes nothing.
      clock += 1_000;
      expect(await googles.connectGoogle(session, await fromGoogle(theirs), client())).toEqual(
        connected,
      );
      // From then on it signs them in; no other account can have it, nor they another.
      expect(
        await googles.signInWithGoogle(await fromGoogle({ sub: subject }), client()),
      ).toMatchObject({ status: 'signed_in', signedUp: false, user: { id: owner.user.id } });
      const other = await signUp();
      expect(
        await authError(
          googles.connectGoogle(
            await auth(other.tokens.accessToken),
            await fromGoogle({ ...theirs, email: other.email }),
            client(),
          ),
        ),
      ).toMatchObject({ code: 'GOOGLE_TAKEN', status: 409 });
      expect(
        await authError(
          googles.connectGoogle(
            session,
            await fromGoogle({ ...theirs, sub: newSubject() }),
            client(),
          ),
        ),
      ).toMatchObject({ code: 'GOOGLE_CONNECTED', status: 409 });

      // Disconnected, it signs in to nothing; the password still does.
      await googles.disconnectGoogle(session, client());
      expect((await googles.me(session)).google).toBeNull();
      expect(
        await authError(googles.signInWithGoogle(await fromGoogle(theirs), client())),
      ).toMatchObject({ code: 'GOOGLE_NOT_CONNECTED' });
      expect(await authError(googles.disconnectGoogle(session, client()))).toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      expect(await events(owner.userId)).toEqual([
        'sign_up',
        'google_connected',
        'sign_in_with_google',
        'google_disconnected',
      ]);
    });

    it('changes the ways an account signs in from a session that proved who is at it lately', async () => {
      const subject = newSubject();
      const opened = signedIn(
        await googles.signInWithGoogle(
          await fromGoogle({
            sub: subject,
            email: uniqueEmail(),
            email_verified: true,
            given_name: 'Kamran',
            family_name: 'Akmal',
          }),
          client(),
        ),
      );
      expect(opened.user.name).toBe('Kamran Akmal');
      const session = await auth(opened.tokens.accessToken);
      // Google is its only way in.
      expect(await authError(googles.disconnectGoogle(session, client()))).toMatchObject({
        code: 'ONLY_SIGN_IN_METHOD',
        status: 409,
      });
      clock += 15 * 60_000;
      expect(await authError(googles.disconnectGoogle(session, client()))).toMatchObject({
        code: 'REAUTHENTICATION_REQUIRED',
        status: 403,
      });
      // And it confirms who is at it with Google again (ADR-201).
      const options = await googles.reauthenticationOptions(session);
      expect(options).toEqual({
        methods: ['google'],
        passkeyOptions: null,
        googleOptions: {
          clientId: issuer.clientId,
          nonce: expect.stringMatching(/^[\w-]{43}$/),
          expiresAt: new Date(clock + 10 * 60_000),
        },
        phone: null,
      });
      const idToken = await issuer.idToken(
        { sub: subject, nonce: options.googleOptions!.nonce },
        { at: new Date(clock) },
      );
      expect(await googles.reauthenticate(session, { googleIdToken: idToken }, client())).toEqual({
        authenticatedAt: new Date(clock),
        sensitiveActionsUntil: new Date(clock + 15 * 60_000),
      });
      expect(
        await authError(
          googles.disconnectGoogle({ ...session, authenticatedAt: new Date(clock) }, client()),
        ),
      ).toMatchObject({ code: 'ONLY_SIGN_IN_METHOD' });

      // An account with a second factor connects Google only from a session that passed it.
      const account = await signUp();
      const before = signedIn(
        await service.signIn({ email: account.email, password: PASSWORD }, client()),
      );
      const { secret } = await service.setUpTotp(await auth(account.tokens.accessToken));
      await service.confirmTotp(await auth(account.tokens.accessToken), code(secret), client());
      expect(
        await authError(
          googles.connectGoogle(
            await auth(before.tokens.accessToken),
            await fromGoogle({ sub: newSubject(), email: account.email, email_verified: true }),
            client(),
          ),
        ),
      ).toMatchObject({ code: 'MFA_REQUIRED', status: 403 });
    });
  });

  describe('email for accounts (ADR-165)', () => {
    /** Sends emails nowhere, keeping each; or none, while it is told not to. */
    class EmailsSent extends AccountEmailSender {
      readonly sent: AccountEmail[] = [];
      working = true;

      async send(email: AccountEmail): Promise<boolean> {
        if (!this.working) return false;
        this.sent.push(email);
        return true;
      }

      /** The token the last email's link carries. */
      get token(): string {
        return /#token=(\S+)/.exec(this.sent.at(-1)!.text)![1]!;
      }
    }

    /** Plays SES's own list of suppressed addresses (ADR-200); or can't be asked, while told so. */
    class SesList implements SesSuppressionList {
      readonly listed = new Map<string, 'bounce' | 'complaint'>();
      working = true;

      async reasonOf(email: string): Promise<'bounce' | 'complaint' | null> {
        if (!this.working) throw new Error('SES not reached');
        return this.listed.get(email) ?? null;
      }

      async remove(email: string): Promise<void> {
        if (!this.working) throw new Error('SES not reached');
        this.listed.delete(email);
      }
    }

    let outbox: EmailsSent;
    let ses: SesList;
    let issuer: GoogleTestIssuer;
    let mailing: IdentityService;
    const events = async (userId: string) =>
      (
        await admin.query<{ kind: string }>(
          'SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id',
          [userId],
        )
      ).rows.map((row) => row.kind);
    /** A minute on: an account may be sent another link. */
    const later = () => (clock += 61_000);
    const signedIn = (result: SignInResult) => {
      if (result.status !== 'signed_in') throw new Error('Expected to be signed in');
      return result;
    };

    beforeAll(async () => {
      outbox = new EmailsSent();
      ses = new SesList();
      issuer = await GoogleTestIssuer.create();
      mailing = new IdentityService({
        db: identityDb.app,
        secretBox,
        rateLimiter: new RateLimiter(redis, `${rateLimitPrefix}-emails`),
        breachedPasswords: { isBreached: async (password) => password === 'password12345' },
        passkeys: PASSKEYS,
        google: { clientIds: [issuer.clientId], keys: issuer.keys },
        emails: { sender: outbox, adminUrl: 'https://admin.hatti.pk/', suppressions: ses },
        now: () => new Date(clock),
      });
    });

    it('sends a link proving the email at sign-up, which proves it once', async () => {
      const email = uniqueEmail();
      const opened = await mailing.signUp(
        { email, password: PASSWORD, name: 'Sana Iqbal', language: 'ur' },
        client(),
      );
      expect(opened.user).toMatchObject({ email, emailVerified: false });
      expect(outbox.sent.at(-1)).toMatchObject({
        to: email,
        subject: 'ہٹی کے لیے اپنی ای میل کی تصدیق کریں',
        text: expect.stringContaining('https://admin.hatti.pk/verify-email#token=hev_'),
        html: expect.stringContaining('dir="rtl"'),
      });
      const token = outbox.token;
      expect(token).toMatch(/^hev_[\w-]{43}$/);
      // Only a digest of its token is kept.
      const { rows } = await admin.query<{ token_hash: Buffer }>(
        'SELECT token_hash FROM identity.email_tokens WHERE user_id = $1',
        [opened.userId],
      );
      expect(rows.map((row) => row.token_hash)).toEqual([sha256(token)]);

      const proved = await mailing.verifyEmail({ token }, client());
      expect(proved.user).toMatchObject({ id: opened.user.id, emailVerified: true });
      expect(await authError(mailing.verifyEmail({ token }, client()))).toMatchObject({
        code: 'INVALID_EMAIL_LINK',
        status: 401,
      });
      const session = await auth(opened.tokens.accessToken);
      expect(await authError(mailing.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'EMAIL_ALREADY_VERIFIED',
        status: 409,
      });
      expect(await events(opened.userId)).toEqual(['sign_up', 'email_verified']);
      // Without a way to send them, no links.
      expect(await authError(service.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'EMAIL_UNAVAILABLE',
        status: 503,
      });
    });

    it('sends links a minute apart and five an hour, the last alone working, for 24 hours', async () => {
      const email = uniqueEmail();
      const account = await mailing.signUp(
        { email, password: PASSWORD, name: 'Omar Farooq' },
        client(),
      );
      const first = outbox.token;
      const session = await auth(account.tokens.accessToken);
      expect(await authError(mailing.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'TOO_SOON',
        status: 429,
        details: { retryAfterMs: 60_000 },
      });
      later();
      expect(await mailing.sendEmailVerification(session, { language: 'en' }, client())).toEqual({
        email,
        expiresAt: new Date(clock + 24 * 3_600_000),
        resendAfter: new Date(clock + 60_000),
      });
      expect(outbox.sent.at(-1)!.subject).toBe('Confirm your email for Hatti');
      // The link before it works no more.
      expect(await authError(mailing.verifyEmail({ token: first }, client()))).toMatchObject({
        code: 'INVALID_EMAIL_LINK',
      });
      for (let link = 3; link <= 5; link++) {
        later();
        await mailing.sendEmailVerification(session, {}, client());
      }
      later();
      expect(await authError(mailing.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'TOO_MANY_EMAILS',
        status: 429,
      });

      // An hour on, one not sent counts against nothing.
      clock += 3_600_000;
      outbox.working = false;
      expect(await authError(mailing.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'EMAIL_NOT_SENT',
        status: 503,
      });
      outbox.working = true;
      await mailing.sendEmailVerification(session, {}, client());
      const last = outbox.token;
      clock += 24 * 3_600_000;
      expect(await authError(mailing.verifyEmail({ token: last }, client()))).toMatchObject({
        code: 'INVALID_EMAIL_LINK',
      });

      // An account opened by phone has no email to prove.
      const [phoneOnly] = (
        await admin.query<{ id: string }>(
          `INSERT INTO identity.users (id, name, phone_e164, phone_verified_at)
           VALUES ($1, 'Bilal', $2, now()) RETURNING id`,
          [newId(), `+92300${String(randomInt(0, 10_000_000)).padStart(7, '0')}`],
        )
      ).rows;
      expect(
        await authError(
          mailing.sendEmailVerification({ ...session, userId: phoneOnly!.id }, {}, client()),
        ),
      ).toMatchObject({ code: 'NO_EMAIL', status: 409 });
    });

    it('resets a forgotten password through a link to the email, signing out everywhere', async () => {
      const email = uniqueEmail();
      const account = await mailing.signUp(
        { email, password: PASSWORD, name: 'Ayesha Khan' },
        client(),
      );
      const elsewhere = signedIn(await mailing.signIn({ email, password: PASSWORD }, client()));
      later();
      await mailing.requestPasswordReset({ email: ` ${email.toUpperCase()} ` }, client());
      expect(outbox.sent.at(-1)).toMatchObject({
        to: email,
        subject: 'Reset your Hatti password',
        text: expect.stringContaining('https://admin.hatti.pk/reset-password#token=hpr_'),
      });
      const token = outbox.token;
      // An email no account has is answered the same, and sent nothing.
      const before = outbox.sent.length;
      await mailing.requestPasswordReset({ email: uniqueEmail() }, client());
      expect(outbox.sent).toHaveLength(before);
      expect(
        await authError(mailing.requestPasswordReset({ email: 'not an email' }, client())),
      ).toMatchObject({ code: 'INVALID_INPUT', status: 422 });

      expect(
        await authError(mailing.resetPassword({ token, password: 'password12345' }, client())),
      ).toMatchObject({
        code: 'INVALID_INPUT',
        details: {
          fields: { password: 'This password has appeared in a data breach. Choose another one' },
        },
      });
      const fresh = 'a new passphrase for the shop';
      await mailing.resetPassword({ token, password: fresh }, client());
      // Every session ended; the old password signs in no more, the new one does, and the email
      // the link went to is proved.
      for (const tokens of [account.tokens, elsewhere.tokens]) {
        expect(await authError(auth(tokens.accessToken))).toMatchObject({ status: 401 });
      }
      expect(
        await authError(mailing.signIn({ email, password: PASSWORD }, client())),
      ).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(await mailing.signIn({ email, password: fresh }, client())).toMatchObject({
        status: 'signed_in',
        user: { emailVerified: true },
      });
      expect(
        await authError(
          mailing.resetPassword({ token, password: 'yet another passphrase' }, client()),
        ),
      ).toMatchObject({ code: 'INVALID_EMAIL_LINK', status: 401 });
      expect(await events(account.userId)).toEqual([
        'sign_up',
        'sign_in',
        'password_reset_requested',
        'password_reset',
        'sign_in_failed',
        'sign_in',
      ]);

      // An hour on, a link resets nothing.
      later();
      await mailing.requestPasswordReset({ email }, client());
      clock += 60 * 60_000;
      expect(
        await authError(mailing.resetPassword({ token: outbox.token, password: fresh }, client())),
      ).toMatchObject({ code: 'INVALID_EMAIL_LINK' });
      // Without a way to send them, no links.
      expect(await authError(service.requestPasswordReset({ email }, client()))).toMatchObject({
        code: 'EMAIL_UNAVAILABLE',
        status: 503,
      });
    });

    it('gives an account opened with Google a password, its second factor still asked after', async () => {
      const email = uniqueEmail();
      // Google proved its email, so it is sent no link to prove it.
      const sentBefore = outbox.sent.length;
      const { nonce } = await mailing.googleOptions(client());
      const idToken = await issuer.idToken(
        {
          sub: `1${String(randomInt(0, 2 ** 47)).padStart(20, '0')}`,
          nonce,
          email,
          email_verified: true,
          name: 'Zara Malik',
        },
        { at: new Date(clock) },
      );
      signedIn(await mailing.signInWithGoogle({ idToken }, client()));
      later();
      await mailing.requestPasswordReset({ email, language: 'ur' }, client());
      expect(outbox.sent).toHaveLength(sentBefore + 1);
      expect(outbox.sent.at(-1)!.subject).toBe('اپنا ہٹی پاس ورڈ دوبارہ بنائیں');
      const own = 'a passphrase of her own';
      await mailing.resetPassword({ token: outbox.token, password: own }, client());
      const withPassword = signedIn(await mailing.signIn({ email, password: own }, client()));

      const session = await auth(withPassword.tokens.accessToken);
      const { secret } = await mailing.setUpTotp(session);
      await mailing.confirmTotp(session, code(secret), client());
      later();
      await mailing.requestPasswordReset({ email }, client());
      const another = 'another passphrase of hers';
      await mailing.resetPassword({ token: outbox.token, password: another }, client());
      expect(await mailing.signIn({ email, password: another }, client())).toMatchObject({
        status: 'mfa_required',
      });
      // A disabled account is sent nothing.
      await admin.query(`UPDATE identity.users SET status = 'disabled' WHERE id = $1`, [
        session.userId,
      ]);
      later();
      const count = outbox.sent.length;
      await mailing.requestPasswordReset({ email }, client());
      expect(outbox.sent).toHaveLength(count);
    });

    it("changes an account's email by a link to the new one, and tells the one before (ADR-172)", async () => {
      const before = uniqueEmail();
      const account = await mailing.signUp(
        { email: before, password: PASSWORD, name: 'Saima Akhtar' },
        client(),
      );
      const session = await auth(account.tokens.accessToken);
      const emailOf = async (userId: string) =>
        (
          await admin.query<{ email: string | null }>(
            'SELECT email FROM identity.users WHERE id = $1',
            [userId],
          )
        ).rows[0]!.email;
      // Not another account's, nor the one it has, nor what is no email.
      const other = uniqueEmail();
      await mailing.signUp({ email: other, password: PASSWORD, name: 'Omar' }, client());
      for (const [email, code, status] of [
        [other.toUpperCase(), 'EMAIL_TAKEN', 409],
        [before, 'EMAIL_UNCHANGED', 409],
        ['not an email', 'INVALID_INPUT', 422],
      ] as const) {
        expect(
          await authError(mailing.requestEmailChange(session, { email }, client())),
        ).toMatchObject({ code, status });
      }

      const after = uniqueEmail();
      later();
      expect(
        await mailing.requestEmailChange(
          session,
          { email: ` ${after.toUpperCase()} `, language: 'ur' },
          client(),
        ),
      ).toEqual({
        email: after,
        expiresAt: new Date(clock + 24 * 3_600_000),
        resendAfter: new Date(clock + 60_000),
      });
      expect(outbox.sent.at(-1)).toMatchObject({
        to: after,
        subject: 'ہٹی کے لیے اپنی نئی ای میل کی تصدیق کریں',
        text: expect.stringContaining('https://admin.hatti.pk/change-email#token=hce_'),
      });
      const token = outbox.token;
      // Nothing changes until it is opened; it proves no email in place of a verification link.
      expect(await emailOf(account.userId)).toBe(before);
      expect(await authError(mailing.verifyEmail({ token }, client()))).toMatchObject({
        code: 'INVALID_EMAIL_LINK',
      });
      const changed = await mailing.confirmEmailChange({ token }, client());
      expect(changed.user).toMatchObject({
        id: account.user.id,
        email: after,
        emailVerified: true,
      });
      // The one before is told, in the link's language.
      expect(outbox.sent.at(-1)).toMatchObject({
        to: before,
        subject: 'آپ کے ہٹی اکاؤنٹ کی ای میل بدل گئی ہے',
        text: expect.stringContaining(after),
      });
      expect(await authError(mailing.confirmEmailChange({ token }, client()))).toMatchObject({
        code: 'INVALID_EMAIL_LINK',
        status: 401,
      });
      expect(await events(account.userId)).toEqual(['sign_up', 'email_changed']);
      expect(
        signedIn(await mailing.signIn({ email: after, password: PASSWORD }, client())).user.email,
      ).toBe(after);
      expect(
        await authError(mailing.signIn({ email: before, password: PASSWORD }, client())),
      ).toMatchObject({ code: 'INVALID_CREDENTIALS' });

      // Taken by another account meanwhile: refused when opened.
      const wanted = uniqueEmail();
      later();
      await mailing.requestEmailChange(session, { email: wanted }, client());
      const late = outbox.token;
      await mailing.signUp({ email: wanted, password: PASSWORD, name: 'Faisal' }, client());
      expect(await authError(mailing.confirmEmailChange({ token: late }, client()))).toMatchObject({
        code: 'EMAIL_TAKEN',
        status: 409,
      });
      expect(await emailOf(account.userId)).toBe(after);

      // An account opened by phone gives itself one the same way; there is none before to tell.
      const [phoneOnly] = (
        await admin.query<{ id: string }>(
          `INSERT INTO identity.users (id, name, phone_e164, phone_verified_at)
           VALUES ($1, 'Bilal', $2, now()) RETURNING id`,
          [newId(), `+92300${String(randomInt(0, 10_000_000)).padStart(7, '0')}`],
        )
      ).rows;
      const given = uniqueEmail();
      await mailing.requestEmailChange(
        { ...session, userId: phoneOnly!.id },
        { email: given },
        client(),
      );
      const sent = outbox.sent.length;
      await mailing.confirmEmailChange({ token: outbox.token }, client());
      expect([await emailOf(phoneOnly!.id), outbox.sent.length]).toEqual([given, sent]);

      // From a session proved lately alone.
      clock += 16 * 60_000;
      expect(
        await authError(mailing.requestEmailChange(session, { email: uniqueEmail() }, client())),
      ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED', status: 403 });
    });

    it('emails an address that bounced again once Google, which answers for it, confirms it; a complaint stays (ADR-200)', async () => {
      const suppress = (email: string, reason: 'bounce' | 'complaint') =>
        admin.query(
          `INSERT INTO identity.email_suppressions (email, reason, detail, feedback_id)
           VALUES ($1, $2, 'smtp; 550 5.1.1 user unknown', '0100018b-feedback')`,
          [email, reason],
        );
      const suppressed = async (...emails: string[]) =>
        (
          await admin.query<{ email: string; reason: string }>(
            `SELECT email, reason FROM identity.email_suppressions
              WHERE email = ANY($1) ORDER BY email`,
            [emails],
          )
        ).rows.map((row) => [row.email, row.reason]);
      const gmail = () => `hatti.${randomBytes(4).toString('hex')}@gmail.com`;
      const newSubject = () => `2${String(randomInt(0, 2 ** 47)).padStart(20, '0')}`;
      const fromGoogle = async (claims: Omit<GoogleTestClaims, 'nonce'>) => {
        const { nonce } = await mailing.googleOptions(client());
        return { idToken: await issuer.idToken({ ...claims, nonce }, { at: new Date(clock) }) };
      };

      // An account opened with a Gmail address that bounced: no link goes to it.
      const zara = gmail();
      const opened = await mailing.signUp(
        { email: zara, password: PASSWORD, name: 'Zara Khan' },
        client(),
      );
      await suppress(zara, 'bounce');
      ses.listed.set(zara, 'bounce');
      const session = await auth(opened.tokens.accessToken);
      later();
      expect(await authError(mailing.sendEmailVerification(session, {}, client()))).toMatchObject({
        code: 'EMAIL_UNDELIVERABLE',
      });
      // Its owner connects Google, which confirms it; SES can't be asked, so nothing is lifted,
      // and Google is connected all the same.
      const subject = newSubject();
      const theirs = { sub: subject, email: zara, email_verified: true };
      ses.working = false;
      expect(
        await mailing.connectGoogle(session, await fromGoogle(theirs), client()),
      ).toMatchObject({ email: zara });
      expect([await suppressed(zara), ses.listed.get(zara)]).toEqual([
        [[zara, 'bounce']],
        'bounce',
      ]);
      // Signing in with it again, SES answering, takes the address off both lists: its link goes.
      ses.working = true;
      expect(await mailing.signInWithGoogle(await fromGoogle(theirs), client())).toMatchObject({
        status: 'signed_in',
        user: { id: opened.user.id },
      });
      expect([await suppressed(zara), ses.listed.has(zara)]).toEqual([[], false]);
      later();
      await mailing.sendEmailVerification(session, {}, client());
      expect(outbox.sent.at(-1)).toMatchObject({ to: zara });

      // An address Google proved once, maybe long ago, and does not answer for: its bounce stays.
      const elsewhere = uniqueEmail();
      await suppress(elsewhere, 'bounce');
      expect(
        await mailing.signInWithGoogle(
          await fromGoogle({ sub: newSubject(), email: elsewhere, email_verified: true }),
          client(),
        ),
      ).toMatchObject({ status: 'signed_in', signedUp: true });
      expect(await suppressed(elsewhere)).toEqual([[elsewhere, 'bounce']]);
      // One of an organisation's on Google Workspace, which it answers for, is lifted as an
      // account opens with it.
      const workspace = `ops-${randomBytes(4).toString('hex')}@hatti-test.pk`;
      await suppress(workspace, 'bounce');
      expect(
        await mailing.signInWithGoogle(
          await fromGoogle({
            sub: newSubject(),
            email: workspace,
            email_verified: true,
            hd: 'hatti-test.pk',
          }),
          client(),
        ),
      ).toMatchObject({ status: 'signed_in', signedUp: true });
      expect(await suppressed(workspace)).toEqual([]);

      // A complaint stays, on Hatti's list or on SES's alone.
      const complained = gmail();
      const missed = gmail();
      await suppress(complained, 'complaint');
      await suppress(missed, 'bounce');
      ses.listed.set(missed, 'complaint');
      for (const email of [complained, missed]) {
        await mailing.signInWithGoogle(
          await fromGoogle({ sub: newSubject(), email, email_verified: true }),
          client(),
        );
      }
      expect(await suppressed(complained, missed)).toEqual(
        [
          [complained, 'complaint'],
          [missed, 'bounce'],
        ].sort(),
      );
      expect(ses.listed.get(missed)).toBe('complaint');

      // Hatti's operators lift either, from both lists, as its command does.
      expect(await suppressionOf(identityDb.app, complained)).toMatchObject({
        reason: 'complaint',
        detail: 'smtp; 550 5.1.1 user unknown',
        feedbackId: '0100018b-feedback',
      });
      for (const email of [complained, missed]) {
        expect(await liftSuppression(identityDb.app, ses, email, { complaints: true })).toBe(
          'lifted',
        );
      }
      expect([await suppressed(complained, missed), ses.listed.has(missed)]).toEqual([[], false]);
      expect(await liftSuppression(identityDb.app, ses, missed, { complaints: true })).toBe(
        'not_suppressed',
      );
      // On SES's list alone, it comes off there; SES unreached, nothing comes off; without SES,
      // Hatti's list alone is kept.
      const sesOnly = gmail();
      ses.listed.set(sesOnly, 'bounce');
      expect(await liftSuppression(identityDb.app, ses, sesOnly)).toBe('lifted');
      expect(ses.listed.has(sesOnly)).toBe(false);
      await suppress(sesOnly, 'bounce');
      ses.working = false;
      expect(await liftSuppression(identityDb.app, ses, sesOnly)).toBe('unreachable');
      ses.working = true;
      expect(await suppressed(sesOnly)).toEqual([[sesOnly, 'bounce']]);
      expect(await liftSuppression(identityDb.app, null, sesOnly)).toBe('lifted');
      expect(await suppressionOf(identityDb.app, sesOnly)).toBeNull();
    });
  });

  describe('sign-in alerts (ADR-179)', () => {
    /** Sends emails nowhere, keeping each; or none, while it is told not to. */
    class EmailsKept extends AccountEmailSender {
      readonly sent: AccountEmail[] = [];
      working = true;

      async send(email: AccountEmail): Promise<boolean> {
        if (!this.working) return false;
        this.sent.push(email);
        return true;
      }
    }

    /** Sends no codes; keeps the alerts it is asked to send to numbers. */
    class NumbersTold extends PhoneCodeSender {
      readonly told: {
        phone: string;
        device: string;
        date: string;
        language: PhoneCodeLanguage;
      }[] = [];

      async send(): Promise<PhoneCodeChannel | null> {
        return null;
      }

      override async tellSignedIn(input: {
        phone: string;
        device: string;
        date: string;
        language: PhoneCodeLanguage;
      }): Promise<PhoneCodeChannel | null> {
        this.told.push(input);
        return 'whatsapp';
      }
    }

    let outbox: EmailsKept;
    let numbers: NumbersTold;
    let alerting: IdentityService;
    const from = (userAgent: string, ip = client().ip): ClientInfo => ({ ip, userAgent });
    const events = async (userId: string) =>
      (
        await admin.query<{ kind: string }>(
          'SELECT kind FROM identity.auth_events WHERE user_id = $1 ORDER BY occurred_at, id',
          [userId],
        )
      ).rows.map((row) => row.kind);
    const signedIn = (result: SignInResult) => {
      if (result.status !== 'signed_in') throw new Error('Expected to be signed in');
      return result;
    };
    const now = () => pakistanTime(new Date(clock));

    /** An account opened from `device`, its email proved, and how many emails went before. */
    async function opened(device: ClientInfo = from(AGENTS.chromeWindows)) {
      const email = uniqueEmail();
      const account = await alerting.signUp(
        { email, password: PASSWORD, name: 'Sana Iqbal' },
        { ...client(), ...device },
      );
      await admin.query('UPDATE identity.users SET email_verified_at = now() WHERE id = $1', [
        account.userId,
      ]);
      return { ...account, email, before: outbox.sent.length };
    }

    beforeAll(() => {
      outbox = new EmailsKept();
      numbers = new NumbersTold();
      alerting = new IdentityService({
        db: identityDb.app,
        secretBox,
        rateLimiter: new RateLimiter(redis, `${rateLimitPrefix}-alerts`),
        passkeys: PASSKEYS,
        phoneCodes: numbers,
        emails: { sender: outbox, adminUrl: 'https://admin.hatti.pk/' },
        now: () => new Date(clock),
      });
    });

    it('emails the owner of a sign-in from a device new to the account, once', async () => {
      // A phone whose client keeps an ID for it, as the admin's do.
      const phone = randomBytes(16).toString('base64url');
      const account = await opened({ userAgent: AGENTS.chromeAndroid, deviceId: phone });
      // The same phone, its browser a version on: known.
      const updated = AGENTS.chromeAndroid.replace('Chrome/129.0.0.0', 'Chrome/130.0.6723.58');
      signedIn(
        await alerting.signIn(
          { email: account.email, password: PASSWORD },
          { ...client(), userAgent: updated, deviceId: phone },
        ),
      );
      expect(outbox.sent.length).toBe(account.before);
      // Another phone of the same make, its browser saying the same: told what signed in, when
      // and from where.
      const other = randomBytes(16).toString('base64url');
      const elsewhere = { ip: '39.45.12.3', userAgent: AGENTS.chromeAndroid, deviceId: other };
      signedIn(await alerting.signIn({ email: account.email, password: PASSWORD }, elsewhere));
      expect(outbox.sent.slice(account.before)).toEqual([
        {
          to: account.email,
          subject: 'New sign-in to your Hatti account',
          text: expect.stringContaining(
            `Your Hatti account was signed in to from Chrome on Android on ${now()}, from the ` +
              'internet address 39.45.12.3.',
          ),
          html: expect.stringContaining('href="https://admin.hatti.pk/"'),
        },
      ]);
      expect(await events(account.userId)).toEqual([
        'sign_up',
        'sign_in',
        'sign_in',
        'sign_in_alerted',
      ]);
      // Known from then on, whatever its address.
      const last = signedIn(
        await alerting.signIn(
          { email: account.email, password: PASSWORD },
          { ...elsewhere, ip: '39.45.200.17' },
        ),
      );
      expect(outbox.sent.length).toBe(account.before + 1);
      // Leaving the ID out never passes for a device that sends one.
      signedIn(await alerting.signIn({ email: account.email, password: PASSWORD }, from(updated)));
      expect(outbox.sent.length).toBe(account.before + 2);
      // The device list says what each session signed in from.
      const listed = await alerting.listSessions(
        await alerting.authenticate(last.tokens.accessToken),
      );
      expect(listed.map((session) => session.device)).toEqual(Array(5).fill('Chrome on Android'));
      // Only a digest of each device's ID with the account's is kept.
      const { rows } = await admin.query<{ device_hash: Buffer | null }>(
        'SELECT device_hash FROM identity.sessions WHERE user_id = $1 ORDER BY created_at, id',
        [account.userId],
      );
      expect(rows.map((row) => row.device_hash)).toEqual([
        sha256(`${account.userId}:${phone}`),
        sha256(`${account.userId}:${phone}`),
        sha256(`${account.userId}:${other}`),
        sha256(`${account.userId}:${other}`),
        null,
      ]);
      // Never the number, while the email was told.
      expect(numbers.told).toEqual([]);
    });

    it('tells the owner in the language they signed up in, or chose since (ADR-194)', async () => {
      const email = uniqueEmail();
      const account = await alerting.signUp(
        { email, password: PASSWORD, name: 'Sana Iqbal', language: 'ur' },
        from(AGENTS.chromeWindows),
      );
      expect(account.user.language).toBe('ur');
      await admin.query('UPDATE identity.users SET email_verified_at = now() WHERE id = $1', [
        account.userId,
      ]);
      const urdu = /\p{Script=Arabic}/u;
      signedIn(await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.chromeAndroid)));
      expect(outbox.sent.at(-1)).toMatchObject({ to: email, subject: expect.stringMatching(urdu) });
      // A link asked for in no language is in theirs too.
      await alerting.requestPasswordReset({ email }, client());
      expect(outbox.sent.at(-1)).toMatchObject({ to: email, subject: expect.stringMatching(urdu) });
      // English from now on, as they chose.
      const session = await alerting.authenticate(account.tokens.accessToken);
      expect((await alerting.setLanguage(session, { language: 'en' })).user.language).toBe('en');
      expect((await alerting.me(session)).user.language).toBe('en');
      signedIn(await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.edgeWindows)));
      expect(outbox.sent.at(-1)!.subject).not.toMatch(urdu);
      // And a number told, where the email can't be, is told in it too.
      const phone = `+92300${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
      await admin.query(
        `UPDATE identity.users SET phone_e164 = $2, phone_verified_at = now(),
                email_verified_at = NULL, language = 'ur'
          WHERE id = $1`,
        [account.userId, phone],
      );
      signedIn(await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.firefoxMac)));
      expect(numbers.told.at(-1)).toMatchObject({ phone, language: 'ur' });
    });

    it('tells the number when the email cannot be told, after a second factor or a passkey', async () => {
      const email = uniqueEmail();
      const account = await alerting.signUp(
        { email, password: PASSWORD, name: 'Bilal Ahmed' },
        from(AGENTS.chromeWindows),
      );
      const phone = `+92300${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
      await admin.query(
        'UPDATE identity.users SET phone_e164 = $2, phone_verified_at = now() WHERE id = $1',
        [account.userId, phone],
      );
      const before = outbox.sent.length;
      // Its email not proved: the number is told.
      signedIn(await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.chromeAndroid)));
      expect(numbers.told.at(-1)).toEqual({
        phone,
        device: 'Chrome on Android',
        date: now(),
        language: 'en',
      });
      // Proved, but it bounced: the number again.
      await admin.query('UPDATE identity.users SET email_verified_at = now() WHERE id = $1', [
        account.userId,
      ]);
      await admin.query(
        `INSERT INTO identity.email_suppressions (email, reason, feedback_id)
         VALUES ($1, 'bounce', 'test')`,
        [email],
      );
      signedIn(await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.edgeWindows)));
      expect(numbers.told.at(-1)).toMatchObject({ phone, device: 'Edge on Windows' });
      expect(outbox.sent.length).toBe(before);

      // After the second factor, once the session is made.
      const session = await alerting.authenticate(account.tokens.accessToken);
      const { secret } = await alerting.setUpTotp(session);
      await alerting.confirmTotp(session, code(secret), client());
      clock += 30_000;
      const told = numbers.told.length;
      const challenge = await alerting.signIn(
        { email, password: PASSWORD },
        from(AGENTS.firefoxMac),
      );
      if (challenge.status !== 'mfa_required') throw new Error('Expected a challenge');
      expect(numbers.told.length).toBe(told);
      await alerting.completeSignIn(
        { challengeToken: challenge.challengeToken, code: code(secret) },
        from(AGENTS.firefoxMac),
      );
      expect(numbers.told.at(-1)).toMatchObject({ phone, device: 'Firefox on Mac' });

      // And with a passkey alone.
      const verified = await alerting.authenticate(
        (
          await alerting.completeSignIn(
            {
              challengeToken: (
                (await alerting.signIn({ email, password: PASSWORD }, from(AGENTS.firefoxMac))) as {
                  challengeToken: string;
                }
              ).challengeToken,
              code: code(secret, (clock += 30_000)),
            },
            from(AGENTS.firefoxMac),
          )
        ).tokens.accessToken,
      );
      const authenticator = new SoftAuthenticator(ORIGIN);
      await alerting.registerPasskey(
        verified,
        { response: authenticator.create(await alerting.passkeyRegistrationOptions(verified)) },
        client(),
      );
      await alerting.signInWithPasskey(
        { response: authenticator.get(await alerting.passkeySignInOptions(client())) },
        from(AGENTS.safariIphone),
      );
      expect(numbers.told.at(-1)).toMatchObject({ phone, device: 'Safari on iPhone' });
      expect(numbers.told.length).toBe(told + 2);
    });

    it('sends five a day at most, and never fails the sign-in it is about', async () => {
      const account = await opened();
      const signIn = (agent: string) =>
        alerting.signIn({ email: account.email, password: PASSWORD }, from(agent));
      for (const agent of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) {
        signedIn(await signIn(`Agent${agent}`));
      }
      expect(outbox.sent.length - account.before).toBe(SIGN_IN_ALERT.perAccountDaily);
      // A day on, another.
      clock += 24 * 3_600_000;
      signedIn(await signIn('AgentGolf'));
      expect(outbox.sent.length - account.before).toBe(SIGN_IN_ALERT.perAccountDaily + 1);
      // The email not sent, and no number to tell: signed in all the same, nothing recorded.
      outbox.working = false;
      try {
        signedIn(await signIn('AgentHotel'));
      } finally {
        outbox.working = true;
      }
      expect(
        (await events(account.userId)).filter((kind) => kind === 'sign_in_alerted'),
      ).toHaveLength(SIGN_IN_ALERT.perAccountDaily + 1);
      // A device not used in 90 days is new again.
      clock += SIGN_IN_ALERT.knownDays * 24 * 3_600_000;
      signedIn(await signIn('AgentGolf'));
      expect(outbox.sent.length - account.before).toBe(SIGN_IN_ALERT.perAccountDaily + 2);
    });
  });
});
