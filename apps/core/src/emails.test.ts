import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accountEmail } from '@hatti/identity/public';
import { createLogger } from '@hatti/logger';
import { signRequest } from '@hatti/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LogEmails, SesEmails, accountEmailsOf } from './emails.js';

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
