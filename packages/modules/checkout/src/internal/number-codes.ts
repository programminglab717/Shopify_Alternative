import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { secretToken, sha256 } from '@hatti/crypto';
import type { Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import type { MessagesService, PhoneChannel } from '@hatti/messaging/public';
import { sql } from 'drizzle-orm';

// Codes that prove a shopper's number at checkout (CHK-09, ADR-148): six digits sent to the number
// they typed, on WhatsApp or by SMS, working for ten minutes and five tries. Only a digest of each
// is kept, and it goes with its checkout.

export const NUMBER_CODE = {
  digits: 6,
  minutes: 10,
  /** Tries at one code. */
  attempts: 5,
  /** Codes one checkout sends. */
  perCheckout: 5,
  /** Codes one number is sent in a day, across the shop's checkouts. */
  perNumberDaily: 10,
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
  /** None was sent to the number in this checkout. */
  | 'none';

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
 * number if it is the code, while its time and tries last.
 */
export async function checkCodeIn(
  tx: Tx,
  shopId: string,
  checkoutId: string,
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
     WHERE shop_id = ${shopId} AND checkout_id = ${checkoutId} AND phone = ${phone}
     ORDER BY created_at DESC
     LIMIT 1
       FOR UPDATE`);
  const sent = rows[0];
  if (!sent) return 'none';
  if (sent.verified_at) return 'verified';
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
 * last one sent stops working. None while the checkout sent as many as it may, or the number was
 * sent as many as it may be in a day.
 */
export async function sendCodeIn(
  tx: Tx,
  messages: MessagesService,
  code: {
    shopId: string;
    checkoutId: string;
    phone: string;
    channel: PhoneChannel;
    shop: string;
  },
): Promise<'sent' | 'too_many'> {
  const { shopId, checkoutId, phone, channel } = code;
  const { rows } = await tx.execute<{ checkout: number; number: number }>(sql`
    SELECT count(*) FILTER (WHERE checkout_id = ${checkoutId})::int AS checkout,
           count(*) FILTER (WHERE phone = ${phone}
                              AND created_at > now() - interval '1 day')::int AS number
      FROM checkout.number_codes
     WHERE shop_id = ${shopId} AND (checkout_id = ${checkoutId} OR phone = ${phone})`);
  const sent = rows[0]!;
  if (sent.checkout >= NUMBER_CODE.perCheckout || sent.number >= NUMBER_CODE.perNumberDaily) {
    return 'too_many';
  }
  const id = newId();
  const digits = String(randomInt(0, 10 ** NUMBER_CODE.digits)).padStart(NUMBER_CODE.digits, '0');
  // The last one sent stops working: only the newest is checked.
  await tx.execute(sql`
    INSERT INTO checkout.number_codes (shop_id, id, checkout_id, phone, channel, code_hash,
                                       expires_at)
    VALUES (${shopId}, ${id}, ${checkoutId}, ${phone}, ${channel}, ${digest(id, digits)},
            now() + ${`${NUMBER_CODE.minutes} minutes`}::interval)`);
  await messages.queueIn(tx, shopId, {
    kind: 'one_time_code',
    recipient: phone,
    channel,
    dedupeKey: `one_time_code:${id}`,
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
