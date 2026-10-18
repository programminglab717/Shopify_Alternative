import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { secretToken, sha256 } from '@hatti/crypto';
import type { Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { MessageLanguage, MessagesService, PhoneChannel } from '@hatti/messaging/public';
import { sql } from 'drizzle-orm';

// Codes that prove a shopper's number at checkout (CHK-09, ADR-148): six digits sent to the number
// they typed, on WhatsApp or by SMS, working for ten minutes and five tries. Only a digest of each
// is kept, and it goes with its checkout. The same codes sign shoppers in to their accounts on the
// shop's storefront (CUS-02, ADR-570), with no checkout: each kept apart by its purpose, so that a
// code sent for one proves nothing for the other, and counted with checkout's against the number
// and the internet address they are sent for. A sign-in code goes a day after it was sent.

export const NUMBER_CODE = {
  digits: 6,
  minutes: 10,
  /** Tries at one code. */
  attempts: 5,
  /** Codes one checkout sends. */
  perCheckout: 5,
  /** Codes one number is sent in a day, across the shop's checkouts. */
  perNumberDaily: 10,
  /**
   * Codes asked for from one internet address in an hour, across the shop's checkouts (ADR-249):
   * an address is shared by many phones on a mobile network, so as many as checkout takes orders
   * from one.
   */
  perAddressHourly: 20,
} as const;

/**
 * A browser that proved a number with a code at a shop's checkout is not asked for another for
 * it for this long (ADR-199), where the shop's risk rules would ask.
 */
export const NUMBER_PROOF = {
  days: 30,
  /** Bytes of the token the browser's cookie keeps. */
  tokenBytes: 16,
} as const;

/** How the code a shopper typed went. */
export type CodeCheck =
  | 'verified'
  /** Not the code sent: tries are left. */
  | 'wrong'
  /** Its ten minutes are up. */
  | 'expired'
  /** Its tries are used up, or no more are sent for now. */
  | 'too_many'
  /** None was sent to the number in this checkout; to sign in, none that is still unused. */
  | 'none';

/**
 * Whose codes: a checkout's, by its ID, or, with null, those that sign shoppers in to the shop's
 * accounts (ADR-570).
 */
function codesOf(checkoutId: string | null) {
  return checkoutId === null
    ? sql`purpose = 'sign_in'`
    : sql`purpose = 'checkout' AND checkout_id = ${checkoutId}`;
}

function digest(id: string, code: string): Buffer {
  return createHash('sha256').update(`${id}:${code}`).digest();
}

/** When the number was proved in the checkout, by a code sent to it; null while it was not. */
export async function numberVerifiedIn(
  tx: Tx,
  shopId: string,
  checkoutId: string,
  phone: string,
): Promise<Date | null> {
  const { rows } = await tx.execute<{ verified_at: string | Date }>(sql`
    SELECT verified_at FROM checkout.number_codes
     WHERE shop_id = ${shopId} AND checkout_id = ${checkoutId} AND phone = ${phone}
       AND verified_at IS NOT NULL
     ORDER BY verified_at DESC
     LIMIT 1`);
  const at = rows[0]?.verified_at;
  return at === undefined ? null : new Date(at);
}

/**
 * Checks `typed` against the last code the checkout sent to `phone`, counting a try: proving the
 * number if it is the code, while its time and tries last. With a null `checkoutId`, against the
 * last code sent to `phone` to sign in (ADR-570), which proves it once: a code that signed in once
 * signs in no one again.
 */
export async function checkCodeIn(
  tx: Tx,
  shopId: string,
  checkoutId: string | null,
  phone: string,
  typed: string,
): Promise<CodeCheck> {
  const { rows } = await tx.execute<{
    id: string;
    code_hash: Buffer;
    attempts: number;
    expired: boolean;
    verified_at: string | Date | null;
  }>(sql`
    SELECT id, code_hash, attempts, expires_at <= now() AS expired, verified_at
      FROM checkout.number_codes
     WHERE shop_id = ${shopId} AND ${codesOf(checkoutId)} AND phone = ${phone}
     ORDER BY created_at DESC
     LIMIT 1
       FOR UPDATE`);
  const sent = rows[0];
  if (!sent) return 'none';
  if (sent.verified_at) return checkoutId === null ? 'none' : 'verified';
  if (sent.attempts >= NUMBER_CODE.attempts) return 'too_many';
  if (sent.expired) return 'expired';
  const code = typed.replace(/\D/g, '');
  const right =
    code.length === NUMBER_CODE.digits && timingSafeEqual(digest(sent.id, code), sent.code_hash);
  await tx.execute(sql`
    UPDATE checkout.number_codes
       SET attempts = attempts + 1, verified_at = ${right ? sql`now()` : null}
     WHERE shop_id = ${shopId} AND id = ${sent.id}`);
  if (right) return 'verified';
  return sent.attempts + 1 >= NUMBER_CODE.attempts ? 'too_many' : 'wrong';
}

/**
 * Sends a new code to `phone` on `channel`, for the checkout, through the shop's messages: the
 * last one sent stops working. None while the checkout sent as many as it may, the number was
 * sent as many as it may be in a day, or the address `ip` the shopper asked from asked for as many
 * as it may in an hour (ADR-249); an address that isn't one counts for nothing. With a null
 * `checkoutId`, a code to sign in with (ADR-570), in its own words, in `language` where given: the
 * last sign-in code sent stops working, and the number's and the address's codes are counted
 * with checkout's.
 */
export async function sendCodeIn(
  tx: Tx,
  messages: MessagesService,
  code: {
    shopId: string;
    checkoutId: string | null;
    phone: string;
    channel: PhoneChannel;
    shop: string;
    ip?: string | null;
    language?: MessageLanguage;
  },
): Promise<'sent' | 'too_many'> {
  const { shopId, checkoutId, phone, channel } = code;
  const ip = code.ip && isIP(code.ip) !== 0 ? code.ip : null;
  const { rows } = await tx.execute<{ checkout: number; number: number; address: number }>(sql`
    SELECT count(*) FILTER (WHERE checkout_id = ${checkoutId})::int AS checkout,
           count(*) FILTER (WHERE phone = ${phone}
                              AND created_at > now() - interval '1 day')::int AS number,
           count(*) FILTER (WHERE ip = ${ip}::inet
                              AND created_at > now() - interval '1 hour')::int AS address
      FROM checkout.number_codes
     WHERE shop_id = ${shopId}
       AND (checkout_id = ${checkoutId} OR phone = ${phone} OR ip = ${ip}::inet)`);
  const sent = rows[0]!;
  if (
    sent.checkout >= NUMBER_CODE.perCheckout ||
    sent.number >= NUMBER_CODE.perNumberDaily ||
    sent.address >= NUMBER_CODE.perAddressHourly
  ) {
    return 'too_many';
  }
  const id = newId();
  const digits = String(randomInt(0, 10 ** NUMBER_CODE.digits)).padStart(NUMBER_CODE.digits, '0');
  const purpose = checkoutId === null ? 'sign_in' : 'checkout';
  // The last one sent stops working: only the newest is checked.
  await tx.execute(sql`
    INSERT INTO checkout.number_codes (shop_id, id, checkout_id, purpose, phone, channel,
                                       code_hash, expires_at, ip)
    VALUES (${shopId}, ${id}, ${checkoutId}, ${purpose}, ${phone}, ${channel},
            ${digest(id, digits)}, now() + ${`${NUMBER_CODE.minutes} minutes`}::interval,
            ${ip}::inet)`);
  const kind = checkoutId === null ? 'account_code' : 'one_time_code';
  await messages.queueIn(tx, shopId, {
    kind,
    recipient: phone,
    channel,
    ...(code.language && { language: code.language }),
    dedupeKey: `${kind}:${id}`,
    variables: { shop: code.shop, code: digits },
  });
  return 'sent';
}

/**
 * Remembers that the browser placing an order proved `phone` with a code at `provedAt` (ADR-199):
 * the token its cookie keeps, of which the shop keeps only a digest, for {@link NUMBER_PROOF}'s
 * days from then. Lapsed proofs are the worker's to delete (ADR-230).
 */
export async function proveBrowserIn(
  tx: Tx,
  shopId: string,
  phone: string,
  provedAt: Date,
): Promise<string> {
  const token = secretToken('', NUMBER_PROOF.tokenBytes);
  const at = provedAt.toISOString();
  await tx.execute(sql`
    INSERT INTO checkout.number_proofs (shop_id, token_hash, phone, proved_at, expires_at)
    VALUES (${shopId}, ${sha256(token)}, ${phone}, ${at}::timestamptz,
            ${at}::timestamptz + ${`${NUMBER_PROOF.days} days`}::interval)`);
  return token;
}

/**
 * When the browser whose cookie keeps `token` proved `phone` with a code at the shop's checkout,
 * if it did within {@link NUMBER_PROOF}'s days (ADR-199); null otherwise, as for another number,
 * another shop's token or one that is none.
 */
export async function provedByBrowserIn(
  tx: Tx,
  shopId: string,
  token: string,
  phone: string,
): Promise<Date | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const { rows } = await tx.execute<{ proved_at: string | Date }>(sql`
    SELECT proved_at FROM checkout.number_proofs
     WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)} AND phone = ${phone}
       AND expires_at > now()`);
  const at = rows[0]?.proved_at;
  return at === undefined ? null : new Date(at);
}
