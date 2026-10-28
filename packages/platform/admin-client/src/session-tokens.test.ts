import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySessionToken } from './session-tokens.js';

const app = { clientId: 'hca_1', clientSecret: 'hcs_secret' };
const NOW = new Date('2026-10-28T09:00:00Z');
const at = Math.floor(NOW.getTime() / 1000);

function sign(claims: object, secret = app.clientSecret, alg = 'HS256'): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

const CLAIMS = {
  iss: 'hatti',
  dest: 'shop_1',
  aud: 'hca_1',
  sub: 'usr_1',
  sid: 'ses_1',
  iat: at,
  nbf: at,
  exp: at + 60,
  jti: 'j1',
};

describe("An embedded app's session token (DEV-06)", () => {
  it('is trusted when it is signed for this app and good now', () => {
    expect(verifySessionToken(sign(CLAIMS), app, NOW)).toMatchObject({
      dest: 'shop_1',
      sub: 'usr_1',
    });
  });

  it('is refused signed otherwise, for another app, out of its minute, or malformed', () => {
    expect(verifySessionToken(sign(CLAIMS, 'hcs_other'), app, NOW)).toBeNull();
    expect(verifySessionToken(sign({ ...CLAIMS, aud: 'hca_2' }), app, NOW)).toBeNull();
    expect(verifySessionToken(sign(CLAIMS, app.clientSecret, 'none'), app, NOW)).toBeNull();
    expect(verifySessionToken(sign(CLAIMS), app, new Date(NOW.getTime() + 70_000))).toBeNull();
    expect(verifySessionToken(sign(CLAIMS), app, new Date(NOW.getTime() - 10_000))).toBeNull();
    expect(verifySessionToken('not.a.token', app, NOW)).toBeNull();
    expect(verifySessionToken(undefined, app, NOW)).toBeNull();
  });
});
