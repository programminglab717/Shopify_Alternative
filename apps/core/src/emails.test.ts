import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accountEmail } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { messageEmail, type OutgoingMessage } from '@hatti/messaging/public';
import { signRequest } from '@hatti/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LogEmails, SesEmails, SesMessageEmails, accountEmailsOf, namedAddress } from './emails.js';

/** What the stand-in for SES was sent. */
interface Asked {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const EMAIL = accountEmail('reset_password', {
  to: 'sana@example.pk',
  name: 'Sana',
  link: 'https://admin.hatti.pk/reset-password#token=hpr_x',
  language: 'en',
});

const logger = createLogger({ name: 'emails-test', level: 'silent' });

describe("Hatti's emails about accounts (ADR-165)", () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  let answer = { status: 200, body: '{"MessageId":"0100018f-abc"}' };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({ url: request.url ?? '', headers: request.headers, body });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ses`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const at = new Date('2026-10-02T21:45:00Z');
  const ses = (options: { baseUrl?: string } = {}) =>
    new SesEmails({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAHATTITEST0000001',
      secretAccessKey: 's'.repeat(40),
      from: 'Hatti <no-reply@hatti.pk>',
      baseUrl: options.baseUrl ?? baseUrl,
      timeoutMs: 2_000,
      now: () => at,
      logger,
    });

  it("sends one through SES's v2 API, signed for SES in its region", async () => {
    expect(await ses().send(EMAIL)).toBe(true);
    expect(asked).toHaveLength(1);
    const [request] = asked;
    expect(request!.url).toBe('/ses/v2/email/outbound-emails');
    expect(JSON.parse(request!.body)).toEqual({
      FromEmailAddress: 'Hatti <no-reply@hatti.pk>',
      Destination: { ToAddresses: ['sana@example.pk'] },
      Content: {
        Simple: {
          Subject: { Data: 'Reset your Hatti password', Charset: 'UTF-8' },
          Body: {
            Text: { Data: EMAIL.text, Charset: 'UTF-8' },
            Html: { Data: EMAIL.html, Charset: 'UTF-8' },
          },
        },
      },
    });
    // Signed as SigV4 signs this request, its body and all.
    const expected = signRequest(
      'POST',
      new URL(`${baseUrl}/v2/email/outbound-emails`),
      { 'content-type': 'application/json' },
      createHash('sha256').update(request!.body).digest('hex'),
      {
        credentials: { accessKeyId: 'AKIAHATTITEST0000001', secretAccessKey: 's'.repeat(40) },
        region: 'ap-southeast-1',
        date: at,
        service: 'ses',
      },
    );
    expect(request!.headers.authorization).toBe(expected.authorization);
    expect(request!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAHATTITEST0000001\/20261002\/ap-southeast-1\/ses\/aws4_request, /,
    );
    expect(request!.headers['x-amz-date']).toBe('20261002T214500Z');
  });

  it("says one did not go when SES refuses it or can't be reached", async () => {
    answer = { status: 400, body: '{"message":"Email address is not verified."}' };
    expect(await ses().send(EMAIL)).toBe(false);
    answer = { status: 200, body: '{}' };
    expect(await ses({ baseUrl: 'http://127.0.0.1:9/ses' }).send(EMAIL)).toBe(false);
  });

  it('sends through SES where it is set up, to the log in development, and nowhere else', () => {
    const local = {
      NODE_ENV: 'development',
      PORT: 4000,
      EMAIL_FROM: 'Hatti <no-reply@hatti.pk>',
    } as const;
    const development = accountEmailsOf(local, logger);
    expect(development?.sender).toBeInstanceOf(LogEmails);
    expect(development?.adminUrl).toBe('http://localhost:4000');
    expect(accountEmailsOf({ ...local, NODE_ENV: 'production' }, logger)).toBeNull();
    const production = accountEmailsOf(
      {
        ...local,
        NODE_ENV: 'production',
        ADMIN_URL: 'https://admin.hatti.pk',
        SES_REGION: 'ap-southeast-1',
        SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
        SES_SECRET_ACCESS_KEY: 's'.repeat(40),
      },
      logger,
    );
    expect(production?.sender).toBeInstanceOf(SesEmails);
    expect(production?.adminUrl).toBe('https://admin.hatti.pk');
    expect(production?.feedback).toBeNull();
    // SES's bounces and complaints, where its topic is set (ADR-170).
    const topicArn = 'arn:aws:sns:ap-southeast-1:123456789012:hatti-ses-feedback';
    expect(
      accountEmailsOf(
        {
          ...local,
          SES_REGION: 'ap-southeast-1',
          SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
          SES_SECRET_ACCESS_KEY: 's'.repeat(40),
          SES_FEEDBACK_TOPIC_ARN: topicArn,
        },
        logger,
      )?.feedback,
    ).toEqual({ topicArn });
    // Staff's passkeys' origin is the admin's, unless told.
    expect(
      accountEmailsOf({ ...local, PASSKEY_ORIGINS: ['https://admin.hatti.pk'] }, logger)?.adminUrl,
    ).toBe('https://admin.hatti.pk');
  });
});

describe("Shops' emails to their customers about their orders (ADR-181)", () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  let answer: { status: number; body: string; headers?: Record<string, string> } = {
    status: 200,
    body: '{"MessageId":"0100018f-order"}',
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        asked.push({ url: request.url ?? '', headers: request.headers, body });
        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ses`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const shipped: OutgoingMessage = {
    id: '01a0f3b1-9685-7065-988d-604298214e34',
    kind: 'order_shipped',
    channel: 'email',
    recipient: 'ayesha@example.pk',
    language: 'en',
    variables: {
      shop: 'Zari Fashions',
      order: '#1043',
      courier: 'PostEx',
      tracking: 'PX123456',
      url: 'https://hatti.pk/o/Zx8kQ2mN4pR6sT0vW1yA3b',
    },
  };
  const ses = (options: { baseUrl?: string } = {}) =>
    new SesMessageEmails({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAHATTITEST0000001',
      secretAccessKey: 's'.repeat(40),
      from: 'Hatti <no-reply@hatti.pk>',
      baseUrl: options.baseUrl ?? baseUrl,
      timeoutMs: 2_000,
      now: () => new Date('2026-10-05T09:30:00Z'),
    });

  it("sends an order's news through SES, from Hatti's address under the shop's name", async () => {
    expect(await ses().send(shipped)).toEqual({ ok: true, providerMessageId: '0100018f-order' });
    const email = messageEmail('order_shipped', 'en', shipped.variables)!;
    expect(asked.map((request) => request.url)).toEqual(['/ses/v2/email/outbound-emails']);
    expect(JSON.parse(asked[0]!.body)).toEqual({
      FromEmailAddress: '"Zari Fashions" <no-reply@hatti.pk>',
      Destination: { ToAddresses: ['ayesha@example.pk'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your order #1043 is on its way', Charset: 'UTF-8' },
          Body: {
            Text: { Data: email.text, Charset: 'UTF-8' },
            Html: { Data: email.html, Charset: 'UTF-8' },
          },
        },
      },
    });
    expect(asked[0]!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAHATTITEST0000001\/20261005\/ap-southeast-1\/ses\/aws4_request, /,
    );
    // Taken with no ID: sent all the same, never twice.
    answer = { status: 200, body: '{}' };
    expect(await ses().send(shipped)).toEqual({
      ok: true,
      providerMessageId: `ses-${shipped.id}`,
    });
  });

  it('tries again what SES refuses for a while, and gives up on what it refuses outright', async () => {
    const refused = async (status: number, type?: string) => {
      answer = {
        status,
        body: '{"message":"No."}',
        headers: type
          ? { 'x-amzn-ErrorType': `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` }
          : {},
      };
      return ses().send(shipped);
    };
    expect(await refused(400, 'MessageRejected')).toEqual({
      ok: false,
      outcome: 'fail',
      error: 'SES MessageRejected: No.',
    });
    expect(await refused(429, 'TooManyRequestsException')).toMatchObject({ outcome: 'retry' });
    expect(await refused(400, 'SendingPausedException')).toMatchObject({ outcome: 'retry' });
    expect(await refused(503)).toEqual({ ok: false, outcome: 'retry', error: 'SES 503: No.' });
    expect(await ses({ baseUrl: 'http://127.0.0.1:9/ses' }).send(shipped)).toEqual({
      ok: false,
      outcome: 'retry',
      error: expect.stringMatching(/^SES not reached: /),
    });
    // A kind no email carries goes nowhere.
    asked.length = 0;
    expect(await ses().send({ ...shipped, kind: 'one_time_code' })).toEqual({
      ok: false,
      outcome: 'fail',
      error: 'No email is written for one_time_code',
    });
    expect(asked).toEqual([]);
  });

  it('names the shop in the From as RFC 5322 has it, in encoded words where it is not ASCII', () => {
    expect(namedAddress('Zari "Lawn" \\ Co', 'no-reply@hatti.pk')).toBe(
      '"Zari \\"Lawn\\" \\\\ Co" <no-reply@hatti.pk>',
    );
    expect(namedAddress(' Zari\n Lawn ', 'no-reply@hatti.pk')).toBe(
      '"Zari Lawn" <no-reply@hatti.pk>',
    );
    expect(namedAddress('  ', 'no-reply@hatti.pk')).toBe('no-reply@hatti.pk');
    expect(namedAddress(undefined, 'no-reply@hatti.pk')).toBe('no-reply@hatti.pk');
    const urdu = 'زری فیشنز اور لان ہاؤس، لاہور';
    const words = namedAddress(urdu, 'no-reply@hatti.pk')
      .replace(/ <no-reply@hatti\.pk>$/, '')
      .split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    // Each word whole characters: read back, the name as it was.
    const read = words.map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'));
    expect(read.join('')).toBe(urdu);
    expect(read.join('')).not.toContain(String.fromCharCode(0xfffd));
  });
});
