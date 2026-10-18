import { InputChecker, PublicSite, shopProfile, type FieldError } from '@hatti/api';
import {
  customerExistsIn,
  customerOfPhoneIn,
  storeCreditOfCustomerIn,
} from '@hatti/customers/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  MESSAGE_LANGUAGES,
  MessagesService,
  type MessageLanguage,
  type PhoneChannel,
} from '@hatti/messaging/public';
import { ORDER_LINK_PATH, accountOrderLinkIn, accountOrdersIn } from '@hatti/orders/public';
import { maskPkMobile } from '@hatti/pk';
import type { AccountJson, AccountSessionJson } from '@hatti/storefront-api';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { checkCodeIn, sendCodeIn } from './number-codes.js';

// Shoppers' accounts on a shop's storefront (CUS-02, ADR-570): a shopper signs in with their
// mobile number and a code sent to it, as at checkout (CHK-09), but a code of its own purpose,
// which places no order, as checkout's signs no one in. The code proved gives the browser a
// session: a random token for its cookie, of which the shop keeps only a digest, with the number
// it proved. Through it the storefront reads the account of the customer the number is now: their
// orders, numbers merged into them too, and their store credit. A number no customer has signs in
// all the same, to an account with nothing in it, so that signing in says nothing of who shops
// there.

export const ACCOUNT_SESSION = {
  /** Bytes of the token the browser's cookie keeps. */
  tokenBytes: 32,
  /** A session ends this long after it was last used… */
  idleDays: 30,
  /** …and this long after it signed in, however much it is used. */
  maxDays: 90,
  /** How often using it moves when it was last used, and so when it ends. */
  touchMinutes: 60,
  /** The orders an account lists, the newest first. */
  orders: 20,
} as const;

/** A token as {@link secretToken} makes them: anything else names no session, unlooked for. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Where a shopper signs in from, as their browser told the storefront. */
export interface AccountClient {
  ip: string | null;
}

/** What asking for a code came to. */
export type SignInStart =
  | { kind: 'sent' | 'too_many'; phone: string; channel: PhoneChannel }
  | { kind: 'invalid'; errors: FieldError[] };

/** What a code typed came to: signed in, with the token given only now, or why not. */
export type SignInVerify =
  | { kind: 'signed_in'; token: string; session: AccountSessionRecord }
  | { kind: 'wrong' | 'expired' | 'too_many' | 'invalid' };

/** A session signed in, as the storefront reads it. */
export interface AccountSessionRecord {
  id: string;
  /** E.164. */
  phone: string;
  /** The customer the number is now; null for a number no customer has. */
  customerId: string | null;
  name: string | null;
  signedInAt: Date;
  expiresAt: Date;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly db: Database,
    private readonly messages: MessagesService,
    private readonly site: PublicSite,
  ) {}

  /**
   * Sends a code to sign in with to `asked.phone`, on `asked.channel`, in the storefront's
   * `asked.locale` where it is one of the platform's languages: whether it went, which is the
   * same for any number, as checkout's codes are. As many go to a number in a day, and from an
   * address in an hour, as checkout's, counted together with them (ADR-249); the last sent to
   * the number to sign in stops working.
   */
  async startSignIn(
    shopId: string,
    asked: { phone: string; channel?: PhoneChannel; locale?: string | null },
    client: AccountClient = { ip: null },
  ): Promise<SignInStart> {
    const check = new InputChecker();
    const phone = check.mobile(['phone'], asked.phone, { required: true });
    if (!phone) return { kind: 'invalid', errors: check.errors };
    const channel = asked.channel ?? 'whatsapp';
    // "ur", or "ur-PK" as a browser may name it.
    const locale = (asked.locale ?? '').split('-')[0]!.toLowerCase();
    const language = (MESSAGE_LANGUAGES as readonly string[]).includes(locale)
      ? (locale as MessageLanguage)
      : undefined;
    return this.db.tenant(shopId, async (tx): Promise<SignInStart> => {
      const sent = await sendCodeIn(tx, this.messages, {
        shopId,
        checkoutId: null,
        phone,
        channel,
        shop: (await shopProfile(tx, shopId)).name,
        ip: client.ip,
        ...(language && { language }),
      });
      return { kind: sent, phone: maskPkMobile(phone), channel };
    });
  }

  /**
   * Checks `asked.code` against the last code sent to `asked.phone` to sign in, counting a try as
   * checkout does: signed in once it is the code, with a new session for the number. A code signs
   * in once.
   */
  async verifySignIn(
    shopId: string,
    asked: { phone: string; code: string },
  ): Promise<SignInVerify> {
    const phone = new InputChecker().mobile(['phone'], asked.phone, { required: true });
    if (!phone) return { kind: 'invalid' };
    return this.db.tenant(shopId, async (tx): Promise<SignInVerify> => {
      const checked = await checkCodeIn(tx, shopId, null, phone, asked.code);
      if (checked === 'none') return { kind: 'expired' };
      if (checked !== 'verified') return { kind: checked };
      const customer = await customerOfPhoneIn(tx, shopId, phone);
      const token = secretToken('', ACCOUNT_SESSION.tokenBytes);
      const { rows } = await tx.execute<{
        id: string;
        created_at: string | Date;
        expires_at: string | Date;
      }>(sql`
        INSERT INTO checkout.account_sessions (shop_id, token_hash, phone, customer_id,
                                               expires_at)
        VALUES (${shopId}, ${sha256(token)}, ${phone}, ${customer?.id ?? null},
                now() + ${`${ACCOUNT_SESSION.idleDays} days`}::interval)
        RETURNING id, created_at, expires_at`);
      const row = rows[0]!;
      return {
        kind: 'signed_in',
        token,
        session: {
          id: row.id,
          phone,
          customerId: customer?.id ?? null,
          name: customer?.name ?? null,
          signedInAt: toDate(row.created_at),
          expiresAt: toDate(row.expires_at),
        },
      };
    });
  }

  /**
   * The session `token` names, while it lasts and was not signed out; null otherwise, as for
   * another shop's token or one that is none. Using it keeps it going: at most hourly, it ends
   * {@link ACCOUNT_SESSION}'s idle days from now, but never past its last day.
   */
  async session(shopId: string, token: string): Promise<AccountSessionRecord | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, (tx) => sessionIn(tx, shopId, token));
  }

  /** Signs the session `token` names out: whether there was one to. */
  async signOut(shopId: string, token: string): Promise<boolean> {
    if (!TOKEN.test(token)) return false;
    return this.db.tenant(shopId, async (tx) => {
      // It reads nothing from now, and the worker's sweep deletes it.
      const { rows } = await tx.execute(sql`
        UPDATE checkout.account_sessions
           SET revoked_at = now(), expires_at = least(expires_at, now())
         WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)} AND revoked_at IS NULL
        RETURNING id`);
      return rows.length > 0;
    });
  }

  /**
   * The account of the session `token` names: the number, the customer's name, their latest
   * orders with the shop and their store credit in its currency. Null without a session.
   */
  async account(shopId: string, token: string): Promise<AccountJson | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx): Promise<AccountJson | null> => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      const { currency } = await shopProfile(tx, shopId);
      const orders = session.customerId
        ? await accountOrdersIn(tx, shopId, session.customerId, ACCOUNT_SESSION.orders)
        : [];
      const credit = session.customerId
        ? await storeCreditOfCustomerIn(tx, shopId, session.customerId, currency)
        : { balance: 0n, expiring: null };
      return {
        phone: session.phone,
        name: session.name,
        orders: orders.map((order) => ({
          id: toPublicId('order', order.id),
          name: `#${order.number}`,
          placedAt: order.placedAt.toISOString(),
          status: order.status,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          total: Number(order.total),
          currency: order.currency,
          itemCount: order.itemCount,
          hasPage: order.hasPage,
        })),
        storeCredit: {
          balance: Number(credit.balance),
          currency,
          expiring: credit.expiring && {
            amount: Number(credit.expiring.amount),
            expiresAt: credit.expiring.expiresAt.toISOString(),
          },
        },
      };
    });
  }

  /**
   * The page of the order `orderId`, its public ID, of the account the session `token` names:
   * where the shopper is sent to it, on the core's address. The link its messages carry, or the
   * one the session opened before, while it is still the order's (ADR-160); a new one otherwise,
   * which the session keeps for next time. Null without a session, for an order not the
   * customer's, or one with no page.
   */
  async orderLink(
    shopId: string,
    token: string,
    orderId: string,
  ): Promise<{ path: string; url: string } | null> {
    const id = tryFromPublicId(orderId, 'order');
    if (!id || !TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session?.customerId) return null;
      // The links its messages carry, and the one this session opened before, if it did.
      const pages = this.site.url(`/${ORDER_LINK_PATH}/`);
      const known = (await this.messages.linksIn(tx, shopId, id))
        .filter((url) => url.startsWith(pages))
        .map((url) => url.slice(pages.length));
      const { rows } = await tx.execute<{ opened: string | null }>(sql`
        SELECT order_links ->> ${id}::text AS opened FROM checkout.account_sessions
         WHERE shop_id = ${shopId} AND id = ${session.id}`);
      const opened = rows[0]?.opened ?? null;
      if (opened) known.unshift(opened);
      const path = await accountOrderLinkIn(tx, shopId, session.customerId, id, known);
      if (!path) return null;
      const secret = path.slice(`/${ORDER_LINK_PATH}/`.length);
      if (secret !== opened) {
        await tx.execute(sql`
          UPDATE checkout.account_sessions
             SET order_links = order_links || jsonb_build_object(${id}::text, ${secret}::text)
           WHERE shop_id = ${shopId} AND id = ${session.id}`);
      }
      return { path, url: this.site.url(path) };
    });
  }
}

/** The session as the storefront is given it. */
export function toSessionJson(session: AccountSessionRecord): AccountSessionJson {
  return {
    phone: session.phone,
    name: session.name,
    signedInAt: session.signedInAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * The session `token` names, in the caller's transaction, kept going as {@link
 * AccountService.session} says. It reads the customer the number is now: the one it signed in to,
 * or the one that was merged into since, or, for a number no customer had, the one it is now, as
 * once its first order is placed. A number taken off its customer since, or given to another,
 * ends it.
 */
async function sessionIn(
  tx: Tx,
  shopId: string,
  token: string,
): Promise<AccountSessionRecord | null> {
  const { rows } = await tx.execute<{
    id: string;
    phone: string;
    customer_id: string | null;
    created_at: string | Date;
    expires_at: string | Date;
    stale: boolean;
  }>(sql`
    SELECT id, phone, customer_id, created_at, expires_at,
           last_seen_at <= now() - ${`${ACCOUNT_SESSION.touchMinutes} minutes`}::interval AS stale
      FROM checkout.account_sessions
     WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)}
       AND revoked_at IS NULL AND expires_at > now()`);
  const row = rows[0];
  if (!row) return null;
  const customer = await customerOfPhoneIn(tx, shopId, row.phone);
  const customerId = customer?.id ?? null;
  if (row.customer_id !== null && row.customer_id !== customerId) {
    // The customer it signed in to is still the shop's, and the number is no longer theirs: it
    // was taken off them, or given to another. Gone, it was merged into another, as a merge
    // takes its numbers with it; but a number on no one's since reads no one's account.
    if (customerId === null || (await customerExistsIn(tx, shopId, row.customer_id))) {
      await tx.execute(sql`
        UPDATE checkout.account_sessions
           SET revoked_at = now(), expires_at = least(expires_at, now())
         WHERE shop_id = ${shopId} AND id = ${row.id}`);
      return null;
    }
  }
  let expiresAt = toDate(row.expires_at);
  if (row.stale || row.customer_id !== customerId) {
    const touch = row.stale
      ? sql`, last_seen_at = now(),
              expires_at = least(now() + ${`${ACCOUNT_SESSION.idleDays} days`}::interval,
                                 created_at + ${`${ACCOUNT_SESSION.maxDays} days`}::interval)`
      : sql``;
    const { rows: touched } = await tx.execute<{ expires_at: string | Date }>(sql`
      UPDATE checkout.account_sessions
         SET customer_id = ${customerId} ${touch}
       WHERE shop_id = ${shopId} AND id = ${row.id}
      RETURNING expires_at`);
    expiresAt = toDate(touched[0]!.expires_at);
  }
  return {
    id: row.id,
    phone: row.phone,
    customerId,
    name: customer?.name ?? null,
    signedInAt: toDate(row.created_at),
    expiresAt,
  };
}
