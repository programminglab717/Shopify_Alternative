import { createHmac, timingSafeEqual } from 'node:crypto';

// A shop closed behind its password (ADR-054): a shopper who gives it keeps a pass in a cookie,
// bound to the shop and the password's verifier, so a new password asks everyone again.

/** The cookie that keeps a shopper's pass, named as Shopify's is. */
export const PASSWORD_COOKIE = 'storefront_digest';

/** How long a pass lasts: a month, or until the password changes. */
const PASS_SECONDS = 30 * 24 * 60 * 60;

/** The pass a shopper keeps once they gave the shop's password. */
export function passwordPass(shopId: string, verifier: string): string {
  return createHmac('sha256', verifier).update(`storefront:${shopId}`).digest('base64url');
}

/** Whether `pass`, from a shopper's cookie, is the one {@link passwordPass} gives now. */
export function isPasswordPass(pass: string, shopId: string, verifier: string): boolean {
  const expected = Buffer.from(passwordPass(shopId, verifier));
  const given = Buffer.from(pass);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The cookie that keeps `pass`, the shopper's own, never sent to other sites' pages. */
export function passwordCookie(pass: string, options: { secure: boolean }): string {
  const secure = options.secure ? '; Secure' : '';
  return `${PASSWORD_COOKIE}=${pass}; Max-Age=${PASS_SECONDS}; Path=/; SameSite=Lax; HttpOnly${secure}`;
}
