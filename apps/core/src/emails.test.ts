import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accountEmail } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { messageEmail, type OutgoingMessage } from '@hatti/messaging/public';
import { EMPTY_PAYLOAD_SHA256, signRequest } from '@hatti/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LogEmails,
  LogExportEmails,
  SesEmails,
  SesExportEmails,
  SesMessageEmails,
  SesSuppressions,
  accountEmailsOf,
  exportEmailsOf,
  namedAddress,
  sesSuppressionsOf,
} from './emails.js';

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
    // SES's own list is kept in step as Hatti lifts an address (ADR-200).
    expect(production?.suppressions).toBeInstanceOf(SesSuppressions);
    expect(development?.suppressions).toBeUndefined();
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

  it("sends Hatti's notices of a shop's bills to its owner from Hatti itself, in their language (ADR-195)", async () => {
    asked.length = 0;
    answer = { status: 200, body: '{"MessageId":"0100018f-bill"}' };
    const due: OutgoingMessage = {
      id: '01a0f3b1-9685-7065-988d-604298214e35',
      kind: 'invoice_due',
      channel: 'email',
      recipient: 'ayesha@zari.pk',
      language: 'ur',
      variables: { shop: 'Zari Fashions', invoice: 'HB-1042', plan: 'Starter', amount: 'Rs 2,499' },
    };
    expect(await ses().send(due)).toEqual({ ok: true, providerMessageId: '0100018f-bill' });
    const email = messageEmail('invoice_due', 'ur', due.variables)!;
    expect(JSON.parse(asked[0]!.body)).toMatchObject({
      FromEmailAddress: 'Hatti <no-reply@hatti.pk>',
      Destination: { ToAddresses: ['ayesha@zari.pk'] },
      Content: {
        Simple: {
          Subject: { Data: 'Zari Fashions کی انوائس HB-1042 ادائیگی کی منتظر ہے' },
          Body: { Text: { Data: email.text }, Html: { Data: email.html } },
        },
      },
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

describe('Scheduled exports by email (ADR-183)', () => {
  let server: Server;
  let baseUrl: string;
  const asked: Asked[] = [];
  let answer: { status: number; body: string; headers?: Record<string, string> } = {
    status: 200,
    body: '{"MessageId":"0100018f-export"}',
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

  const workbook = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256));
  const email = {
    to: 'sana@example.pk',
    subject: 'Orders from زری فیشنز اور لان ہاؤس، لاہور: 4 Oct 2026',
    text: 'Assalam o alaikum Sana,',
    html: '<p>Assalam o alaikum Sana,</p>',
    attachment: {
      filename: 'orders-2026-10-04.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: workbook,
    },
  };
  const ses = (options: { baseUrl?: string } = {}) =>
    new SesExportEmails({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAHATTITEST0000001',
      secretAccessKey: 's'.repeat(40),
      from: 'Hatti <no-reply@hatti.pk>',
      baseUrl: options.baseUrl ?? baseUrl,
      timeoutMs: 2_000,
      now: () => new Date('2026-10-05T03:00:00Z'),
      logger,
    });

  it('sends the file attached to its words, as a raw message through SES', async () => {
    expect(await ses().send(email)).toBe('sent');
    const body = JSON.parse(asked[0]!.body) as {
      FromEmailAddress: string;
      Destination: unknown;
      Content: { Raw: { Data: string } };
    };
    expect(body.FromEmailAddress).toBe('Hatti <no-reply@hatti.pk>');
    expect(body.Destination).toEqual({ ToAddresses: ['sana@example.pk'] });
    const message = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8');
    const head = message.split('\r\n\r\n')[0]!.split('\r\n');
    // A subject that is not ASCII goes in encoded words, folded onto lines of their own.
    const folded = head.findIndex((line) => line.startsWith('Date: '));
    expect(folded).toBeGreaterThan(3);
    expect([...head.slice(0, 2), ...head.slice(folded)]).toEqual([
      'From: Hatti <no-reply@hatti.pk>',
      'To: sana@example.pk',
      'Date: Mon, 05 Oct 2026 03:00:00 GMT',
      'MIME-Version: 1.0',
      expect.stringMatching(
        /^Content-Type: multipart\/mixed; boundary="hatti-[0-9a-f]{24}-mixed"$/,
      ),
    ]);
    const words = head.slice(2, folded);
    expect(words[0]).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    for (const line of words.slice(1)) expect(line).toMatch(/^ =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // The subject's encoded words read back as it was.
    const subject = words
      .map((line) => /=\?UTF-8\?B\?([^?]+)\?=/.exec(line)![1]!)
      .map((word) => Buffer.from(word, 'base64').toString('utf8'))
      .join('');
    expect(subject).toBe(email.subject);
    expect(message).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(message).toContain('Content-Type: text/html; charset=UTF-8');
    expect(message).toContain('Content-Disposition: attachment; filename="orders-2026-10-04.xlsx"');
    // The file, in base64 lines of 76 at most, whole.
    const part = message.split('filename="orders-2026-10-04.xlsx"')[1]!;
    const lines = part.split('\r\n\r\n')[1]!.split('\r\n--')[0]!.split('\r\n');
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(lines.join(''), 'base64').equals(workbook)).toBe(true);
    expect(message.endsWith('-mixed--\r\n')).toBe(true);
  });

  it('says what may go later, and what never will', async () => {
    answer = {
      status: 400,
      body: '{"message":"Email address is not verified."}',
      headers: { 'x-amzn-ErrorType': 'MessageRejected:' },
    };
    expect(await ses().send(email)).toBe('failed');
    answer = { status: 503, body: '{}' };
    expect(await ses().send(email)).toBe('retry');
    expect(await ses({ baseUrl: 'http://127.0.0.1:9/ses' }).send(email)).toBe('retry');
  });

  it('sends through SES where it is set up, to the log in development, and nowhere else', () => {
    const local = {
      NODE_ENV: 'development',
      META_GRAPH_URL: 'https://graph.facebook.com',
      META_GRAPH_VERSION: 'v26.0',
      SMS_SENDER: 'Hatti',
      EMAIL_FROM: 'Hatti <no-reply@hatti.pk>',
    };
    expect(exportEmailsOf(local, logger)).toBeInstanceOf(LogExportEmails);
    expect(exportEmailsOf({ ...local, NODE_ENV: 'production' }, logger)).toBeNull();
    expect(
      exportEmailsOf(
        {
          ...local,
          NODE_ENV: 'production',
          SES_REGION: 'ap-southeast-1',
          SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
          SES_SECRET_ACCESS_KEY: 's'.repeat(40),
        },
        logger,
      ),
    ).toBeInstanceOf(SesExportEmails);
  });
});

describe("SES's own list of suppressed addresses (ADR-200)", () => {
  let server: Server;
  let baseUrl: string;
  const asked: (Asked & { method: string })[] = [];
  let answer = { status: 200, body: '{}' };

  beforeAll(async () => {
    server = createServer((request, response) => {
      asked.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: '',
      });
      request.resume();
      request.on('end', () => {
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

  const at = new Date('2026-10-05T10:15:00Z');
  const list = (options: { baseUrl?: string } = {}) =>
    new SesSuppressions({
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAHATTITEST0000001',
      secretAccessKey: 's'.repeat(40),
      from: 'Hatti <no-reply@hatti.pk>',
      baseUrl: options.baseUrl ?? baseUrl,
      timeoutMs: 2_000,
      now: () => at,
    });

  it('asks SES why its list has an address, by the address in the path, signed as SES checks it', async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        SuppressedDestination: { EmailAddress: 'sana+shop@gmail.com', Reason: 'BOUNCE' },
      }),
    };
    expect(await list().reasonOf('sana+shop@gmail.com')).toBe('bounce');
    const [request] = asked.splice(0);
    expect([request!.method, request!.url]).toEqual([
      'GET',
      '/ses/v2/email/suppression/addresses/sana%2Bshop%40gmail.com',
    ]);
    // Its path signed encoded once more, as SES has it for every service but S3.
    const expected = signRequest(
      'GET',
      new URL(`${baseUrl}/v2/email/suppression/addresses/sana%2Bshop%40gmail.com`),
      {},
      EMPTY_PAYLOAD_SHA256,
      {
        credentials: { accessKeyId: 'AKIAHATTITEST0000001', secretAccessKey: 's'.repeat(40) },
        region: 'ap-southeast-1',
        date: at,
        service: 'ses',
      },
    );
    expect(request!.headers.authorization).toBe(expected.authorization);
    answer = { status: 200, body: '{"SuppressedDestination":{"Reason":"COMPLAINT"}}' };
    expect(await list().reasonOf('bilal@example.pk')).toBe('complaint');
    // Not on its list.
    answer = { status: 404, body: '{"message":"Email address bilal@example.pk does not exist"}' };
    expect(await list().reasonOf('bilal@example.pk')).toBeNull();
    // SES in trouble, or saying nothing it can be understood by: never taken as not listed.
    answer = { status: 500, body: '{}' };
    await expect(list().reasonOf('bilal@example.pk')).rejects.toThrow(/500/);
    answer = { status: 200, body: '{"SuppressedDestination":{}}' };
    await expect(list().reasonOf('bilal@example.pk')).rejects.toThrow(/no reason/);
    await expect(
      list({ baseUrl: 'http://127.0.0.1:9/ses' }).reasonOf('bilal@example.pk'),
    ).rejects.toThrow();
    asked.splice(0);
  });

  it('takes an address off it, as one not on it is already off', async () => {
    answer = { status: 200, body: '{}' };
    await list().remove('Zara.Khan@gmail.com');
    expect(asked.splice(0).map((request) => [request.method, request.url])).toEqual([
      ['DELETE', '/ses/v2/email/suppression/addresses/Zara.Khan%40gmail.com'],
    ]);
    answer = { status: 404, body: '{}' };
    await list().remove('zara@gmail.com');
    answer = { status: 429, body: '{"message":"Too many requests"}' };
    await expect(list().remove('zara@gmail.com')).rejects.toThrow(/429/);
    asked.splice(0);
  });

  it('is asked where SES is set up alone', () => {
    const config = { EMAIL_FROM: 'Hatti <no-reply@hatti.pk>' };
    expect(sesSuppressionsOf(config)).toBeNull();
    expect(
      sesSuppressionsOf({
        ...config,
        SES_REGION: 'ap-southeast-1',
        SES_ACCESS_KEY_ID: 'AKIAHATTITEST0000001',
        SES_SECRET_ACCESS_KEY: 's'.repeat(40),
      }),
    ).toBeInstanceOf(SesSuppressions);
  });
});
