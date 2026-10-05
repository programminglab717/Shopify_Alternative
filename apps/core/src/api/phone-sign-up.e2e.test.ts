import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import {
  PhoneCodeSender,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
} from '@hatti/identity/public';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Keeps each code it is given to send. */
class CodesSent extends PhoneCodeSender {
  readonly codes: string[] = [];

  async send(input: {
    phone: string;
    code: string;
    channel: PhoneCodeChannel;
    language: PhoneCodeLanguage;
  }): Promise<PhoneCodeChannel | null> {
    this.codes.push(input.code);
    return input.channel;
  }
}

describe.skipIf(!server)(
  '/auth/phone: merchants sign up and in with their number (ADR-159)',
  () => {
    let testDb: TestDatabase;
    let api: TestApi;
    let admin: pg.Client;
    const sent = new CodesSent();

    const post = (url: string, payload: unknown, token?: string) =>
      api.app.inject({
        method: 'POST',
        url,
        payload: payload as Record<string, unknown>,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      api = await startTestApi(testDb, { phoneCodes: sent });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
    });

    afterAll(async () => {
      await admin?.end();
      await api?.close();
      await testDb?.drop();
    });

    it('sends a code, opens an account with the number proved, and opens a shop with it', async () => {
      const asked = await post('/auth/phone/code', { phone: '0321 4567890', language: 'ur' });
      expect([asked.statusCode, asked.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(asked.json()).toEqual({
        phone: '+92 321 •••7890',
        channel: 'whatsapp',
        expiresAt: expect.any(String),
        resendAfter: expect.any(String),
      });
      const tooSoon = await post('/auth/phone/code', { phone: '+923214567890' });
      expect([
        tooSoon.statusCode,
        tooSoon.headers['retry-after'],
        tooSoon.json().error.code,
      ]).toEqual([429, '30', 'TOO_SOON']);
      const elsewhere = await post('/auth/phone/code', { phone: '+1 415 555 0100' });
      expect([elsewhere.statusCode, elsewhere.json().error.fields]).toEqual([
        422,
        { phone: 'Enter a Pakistani mobile number like 0300 1234567' },
      ]);

      const code = sent.codes[0]!;
      const wrong = await post('/auth/phone/sign-in', {
        phone: '0321 4567890',
        code: `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`,
      });
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([401, 'INVALID_CODE']);
      const proved = await post('/auth/phone/sign-in', {
        phone: '0321-4567890',
        code,
      });
      expect([proved.statusCode, proved.json()]).toEqual([
        200,
        {
          status: 'sign_up_required',
          signUpToken: expect.stringMatching(/^hsu_/),
          signUpTokenExpiresAt: expect.any(String),
          phone: '+92 321 •••7890',
        },
      ]);
      const opened = await post('/auth/phone/sign-up', {
        signUpToken: proved.json().signUpToken,
        name: 'Bilal Ahmed',
      });
      expect([opened.statusCode, opened.headers['cache-control']]).toEqual([201, 'no-store']);
      const body = opened.json() as Json;
      expect(body).toMatchObject({
        user: {
          email: null,
          name: 'Bilal Ahmed',
          phone: '+923214567890',
          phoneVerified: true,
          mfaEnabled: false,
        },
        accessToken: expect.stringMatching(/^hsa_/),
        session: { mfaVerified: false },
      });
      const me = await api.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(me.json()).toMatchObject({
        user: { phone: '+923214567890', email: null, language: 'en' },
        shops: [],
      });
      // Hatti's words to him in Urdu from now on (ADR-194); nothing else is a language of its.
      const urdu = await post('/auth/language', { language: 'ur' }, body.accessToken);
      expect([urdu.statusCode, urdu.json().user.language]).toEqual([200, 'ur']);
      expect((await post('/auth/language', { language: 'fr' }, body.accessToken)).statusCode).toBe(
        400,
      );
      const shop = await post('/auth/shops', { name: 'Bilal Shoes' }, body.accessToken);
      expect([shop.statusCode, shop.json().shop]).toMatchObject([
        201,
        { name: 'Bilal Shoes', handle: 'bilal-shoes', role: 'owner' },
      ]);
      // The token opened one account.
      const again = await post('/auth/phone/sign-up', {
        signUpToken: proved.json().signUpToken,
        name: 'Bilal Ahmed',
      });
      expect([again.statusCode, again.json().error.code]).toEqual([401, 'INVALID_SIGN_UP']);
    });

    it('confirms who is at an account opened by phone with a code sent to its number (ADR-201)', async () => {
      await post('/auth/phone/code', { phone: '0345 1122334' });
      const proved = await post('/auth/phone/sign-in', {
        phone: '0345 1122334',
        code: sent.codes.at(-1),
      });
      const opened = await post('/auth/phone/sign-up', {
        signUpToken: proved.json().signUpToken,
        name: 'Saima Akhtar',
      });
      const token = opened.json().accessToken as string;
      const options = await post('/auth/reauthenticate/options', {}, token);
      expect(options.json()).toEqual({
        methods: ['phone'],
        passkeyOptions: null,
        googleOptions: null,
        phone: '+92 345 •••2334',
      });
      // The number waits between codes, whatever they are for.
      const tooSoon = await post('/auth/reauthenticate/code', {}, token);
      expect([tooSoon.statusCode, tooSoon.json().error.code]).toEqual([429, 'TOO_SOON']);
      await admin.query(
        `UPDATE identity.phone_codes SET created_at = created_at - interval '1 minute'
          WHERE phone = '+923451122334'`,
      );
      const asked = await post('/auth/reauthenticate/code', { channel: 'sms' }, token);
      expect([asked.statusCode, asked.headers['cache-control'], asked.json()]).toEqual([
        200,
        'no-store',
        {
          phone: '+92 345 •••2334',
          channel: 'sms',
          expiresAt: expect.any(String),
          resendAfter: expect.any(String),
        },
      ]);
      // One way at a time.
      const two = await post('/auth/reauthenticate', { phoneCode: '123456', password: 'x' }, token);
      expect([two.statusCode, two.json().error.code]).toEqual([400, 'INVALID_INPUT']);
      const confirmed = await post('/auth/reauthenticate', { phoneCode: sent.codes.at(-1) }, token);
      expect(confirmed.statusCode).toBe(200);
      const { authenticatedAt } = confirmed.json() as Record<string, string>;
      const me = await api.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.json().session).toMatchObject({ authenticatedAt, mfaVerified: false });
    });

    it('proves a number for an account opened with an email, which signs it in from then on', async () => {
      const opened = await post('/auth/sign-up', {
        email: 'imran@example.pk',
        password: 'correct horse battery staple',
        name: 'Imran Shah',
      });
      const token = (opened.json() as Json).accessToken;
      expect((await post('/auth/phone/code', { phone: '0333 7654321' })).statusCode).toBe(200);
      const added = await post(
        '/auth/phone',
        { phone: '0333 7654321', code: sent.codes.at(-1) },
        token,
      );
      expect([added.statusCode, added.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(added.json().user).toMatchObject({
        email: 'imran@example.pk',
        phone: '+923337654321',
        phoneVerified: true,
      });
      const anonymous = await post('/auth/phone', { phone: '0333 7654321', code: '123456' });
      expect(anonymous.statusCode).toBe(401);

      // Its password signs it in too, so the number may come off it, and signs in to nothing then
      // (ADR-202).
      const removed = await api.app.inject({
        method: 'DELETE',
        url: '/auth/phone',
        headers: { authorization: `Bearer ${token}` },
      });
      expect([removed.statusCode, removed.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(removed.json().user).toMatchObject({ phone: null, phoneVerified: false });
      const again = await api.app.inject({
        method: 'DELETE',
        url: '/auth/phone',
        headers: { authorization: `Bearer ${token}` },
      });
      expect([again.statusCode, again.json().error.code]).toEqual([404, 'NOT_FOUND']);
    });
  },
);
