import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WEB_PUSH,
  WebPushSender,
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
} from './web-push.js';

/** A browser's subscription: its key pair and authentication secret. */
function browser() {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    keys,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: keys.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  };
}

/** What the browser reads of a pushed body (RFC 8291), as it would decrypt it. */
function decrypt(body: Buffer, keys: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  expect(recordSize).toBe(WEB_PUSH.recordSize);
  const shared = keys.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), keys.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  // The last record ends with its delimiter.
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString();
}

describe('Web Push (APP-03, ADR-506)', () => {
  it('encrypts a message that only the browser that subscribed can read (RFC 8291)', () => {
    const { keys, subscription } = browser();
    const message = JSON.stringify({ title: 'New order #1042', body: 'Rs 4,500 · Lahore' });
    const body = encryptPayload(subscription, Buffer.from(message));
    expect(decrypt(body, keys, Buffer.from(subscription.auth, 'base64url'))).toBe(message);
    // Each message with a key and salt of its own.
    expect(encryptPayload(subscription, Buffer.from(message)).equals(body)).toBe(false);
    // Another browser cannot read it.
    const other = browser();
    expect(() => decrypt(body, other.keys, Buffer.from(subscription.auth, 'base64url'))).toThrow();
    expect(() =>
      encryptPayload({ p256dh: 'AAAA', auth: subscription.auth }, Buffer.from('x')),
    ).toThrow('The subscription has no browser key or authentication secret to encrypt for');
  });

  it("signs a request with Hatti's VAPID key for the push service's origin, 12 hours (RFC 8292)", () => {
    const keys = { ...generateVapidKeys(), subject: 'mailto:push@hatti.pk' };
    const now = new Date('2026-10-17T10:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', keys, now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: 'mailto:push@hatti.pk',
    });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('sends to the push service, and says when the subscription is gone', async () => {
    const { keys, subscription } = browser();
    const requests: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const sender = new WebPushSender(
      { ...generateVapidKeys(), subject: 'mailto:push@hatti.pk' },
      (async (url: URL, init: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(null, { status });
      }) as typeof fetch,
    );
    expect(
      await sender.send(subscription, { title: 'Hi' }, { urgency: 'high', topic: 'order-1' }),
    ).toBe('sent');
    const [sent] = requests;
    expect(sent!.url).toBe(subscription.endpoint);
    expect(sent!.init.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '86400',
      urgency: 'high',
      topic: 'order-1',
    });
    expect(
      decrypt(sent!.init.body as Buffer, keys, Buffer.from(subscription.auth, 'base64url')),
    ).toBe('{"title":"Hi"}');
    status = 410;
    expect(await sender.send(subscription, { title: 'Hi' })).toBe('gone');
    status = 503;
    expect(await sender.send(subscription, { title: 'Hi' })).toBe('failed');
    expect(await sender.send({ ...subscription, endpoint: 'http://push.example' }, {})).toBe(
      'gone',
    );
  });
});
