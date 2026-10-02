import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import {
  PhoneCodeSender,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
} from '@hatti/identity/public';
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
    });

    afterAll(async () => {
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
      expect(me.json()).toMatchObject({ user: { phone: '+923214567890', email: null }, shops: [] });
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
  },
);
