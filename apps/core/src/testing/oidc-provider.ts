import { generateKeyPairSync, randomUUID, sign as signWith, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Given {
  email: string;
  nonce: string;
  verified?: boolean;
  amr?: string[];
}

/**
 * An identity provider, as OpenID Connect has it, for tests: its configuration, its keys, and a
 * token endpoint trading the codes the test gives out for ID tokens it signs for `client`. A
 * shop's organisation's (ADR-864), or Hatti's own for its console (ADR-876).
 */
export async function fakeOidcProvider(client: { id: string; secret: string }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Given>();
  let base = '';
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  /** An ID token, RS256 as providers sign them. */
  const sign = (claims: Record<string, unknown>, key: KeyObject = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${part({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })}.${part({
      iss: base,
      aud: client.id,
      sub: `user-${String(claims.email)}`,
      iat: now,
      exp: now + 300,
      ...claims,
    })}`;
    return `${body}.${signWith('sha256', Buffer.from(body), key).toString('base64url')}`;
  };
  const http: Server = createServer((request, response) => {
    const url = new URL(request.url!, base);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const form = new URLSearchParams(body);
        const basic = Buffer.from(
          (request.headers.authorization ?? '').replace(/^Basic /, ''),
          'base64',
        ).toString('utf8');
        const given = codes.get(form.get('code') ?? '');
        if (basic !== `${client.id}:${client.secret}` || !given || !form.get('code_verifier')) {
          return json(400, { error: 'invalid_grant' });
        }
        codes.delete(form.get('code')!);
        json(200, {
          access_token: 'at',
          id_token: sign({
            email: given.email,
            email_verified: given.verified ?? true,
            nonce: given.nonce,
            ...(given.amr && { amr: given.amr }),
          }),
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    http,
    get issuer() {
      return base;
    },
    /** The provider signing `email` in for the sign-in its authorize address began. */
    signIn(
      authorizeUrl: string,
      email: string,
      options: { verified?: boolean; nonce?: string; amr?: string[] } = {},
    ) {
      const url = new URL(authorizeUrl);
      const code = randomUUID();
      codes.set(code, {
        email,
        nonce: options.nonce ?? url.searchParams.get('nonce')!,
        ...(options.verified !== undefined && { verified: options.verified }),
        ...(options.amr && { amr: options.amr }),
      });
      return { code, state: url.searchParams.get('state')! };
    },
  };
}
