import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

// The Web Push protocol (APP-03, ADR-506), as browsers' push services take it: a message's body
// encrypted for the one browser that subscribed (RFC 8291, aes128gcm), and the request signed
// with Hatti's VAPID key (RFC 8292), so that the push service knows it comes from the server the
// browser subscribed with. No library: node's crypto has every part.

/** A browser's push subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key, uncompressed, base64url. */
  p256dh: string;
  /** Its 16-byte authentication secret, base64url. */
  auth: string;
}

/** Hatti's VAPID key pair, base64url: the public key uncompressed, the private one raw. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** Who runs the server, for push services to reach: "mailto:push@hatti.pk". */
  subject: string;
}

export const WEB_PUSH = {
  /** The record size: one record holds a notification. */
  recordSize: 4096,
  /** What a push service keeps an undelivered message for, in seconds: a day. */
  ttl: 86_400,
  /** How long a VAPID token is good for, in seconds: 12 hours, half what push services allow. */
  tokenLifetime: 12 * 3600,
  /** The most a message's body may be, before encryption, in bytes. */
  maxPayload: 3_000,
} as const;

const b64 = (data: Buffer) => data.toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url');

/** A new VAPID key pair, for whoever runs Hatti to put in its environment. */
export function generateVapidKeys(): Omit<VapidKeys, 'subject'> {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

/**
 * `payload` encrypted for the browser of `subscription` (RFC 8291): the aes128gcm header, with a
 * key of the server's made for this message alone, then one record. `keys` and `salt` are for
 * tests, which must be able to repeat a message.
 */
export function encryptPayload(
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  payload: Buffer,
  options: { serverKeys?: ReturnType<typeof createECDH>; salt?: Buffer } = {},
): Buffer {
  const browserKey = unb64(subscription.p256dh);
  const authSecret = unb64(subscription.auth);
  if (browserKey.length !== 65 || browserKey[0] !== 4 || authSecret.length !== 16) {
    throw new Error('The subscription has no browser key or authentication secret to encrypt for');
  }
  if (payload.length > WEB_PUSH.maxPayload) throw new Error('The message is too long to push');
  const server =
    options.serverKeys ??
    (() => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return ecdh;
    })();
  const serverKey = server.getPublicKey();
  const shared = server.computeSecret(browserKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browserKey, serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = options.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The last record's delimiter, then no padding.
  const record = Buffer.concat([
    cipher.update(payload),
    cipher.update(Buffer.from([2])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(WEB_PUSH.recordSize, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, record, cipher.getAuthTag()]);
}

/**
 * The Authorization header that signs a request to `endpoint` with Hatti's VAPID key (RFC 8292):
 * a JWT for the push service's origin, good for 12 hours, and the public key it is checked with.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = new Date()): string {
  const publicKey = unb64(keys.publicKey);
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64(publicKey.subarray(1, 33)),
      y: b64(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const part = (value: object) => b64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + WEB_PUSH.tokenLifetime,
    sub: keys.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

/** What became of a push: sent, the subscription gone for good, or a failure worth trying again. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Sends pushes to browsers' push services, signed with Hatti's VAPID key. */
export class WebPushSender {
  constructor(
    private readonly keys: VapidKeys,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /**
   * Pushes `message`, JSON, to the browser of `subscription`, urgently or not: `gone` where the
   * push service says the subscription no longer exists, so that it is forgotten.
   */
  async send(
    subscription: PushSubscriptionKeys,
    message: object,
    options: { urgency?: 'high' | 'normal'; topic?: string } = {},
  ): Promise<PushOutcome> {
    let url: URL;
    try {
      url = new URL(subscription.endpoint);
    } catch {
      return 'gone';
    }
    if (url.protocol !== 'https:') return 'gone';
    const body = encryptPayload(subscription, Buffer.from(JSON.stringify(message)));
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(subscription.endpoint, this.keys),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(WEB_PUSH.ttl),
          urgency: options.urgency ?? 'normal',
          // A newer message of the same topic replaces one not yet delivered.
          ...(options.topic && { topic: options.topic.slice(0, 32) }),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 410) return 'gone';
      return response.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
