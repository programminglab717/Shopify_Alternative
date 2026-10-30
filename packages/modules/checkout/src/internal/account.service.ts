import { InputChecker, PublicSite, shopProfile, type FieldError } from '@hatti/api';
import {
  DEFAULT_VARIANT_TITLE,
  bundlesContainingIn,
  bundlesOfProductsIn,
  giftCardProductIdsIn,
  variantNamesIn,
  type BundleRecord,
} from '@hatti/catalog/public';
import {
  CustomerDataService,
  ERASURE_WAIT_DAYS,
  customerExistsIn,
  customerOfPhoneIn,
  storeCreditHistoryOfCustomerIn,
  storeCreditOfCustomerIn,
  type OwnErasureRecord,
} from '@hatti/customers/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { newId, toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  MESSAGE_LANGUAGES,
  MessagesService,
  referralCodeIn,
  referralProgramIn,
  type MessageLanguage,
  type PhoneChannel,
} from '@hatti/messaging/public';
import {
  ORDER_LINK_PATH,
  accountOrderLinkIn,
  accountOrdersIn,
  pastOrdersOfCustomerIn,
  subscriptionsOfCustomerIn,
  type AccountOrderItemFacts,
} from '@hatti/orders/public';
import { maskPkMobile, parsePkMobile } from '@hatti/pk';
import { ObjectStorage } from '@hatti/storage';
import {
  ACCOUNT_ADDRESSES_MAX,
  type AccountAddress,
  type AccountAddressRequest,
  type AccountDataEraseResponse,
  type AccountDataExportJson,
  type AccountDataExportResponse,
  type AccountDataRequestsJson,
  type AccountErasureJson,
  type AccountJson,
  type AccountOrderLineJson,
  type AccountSessionJson,
} from '@hatti/storefront-api';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  addressBooksIn,
  addressesIn,
  deleteAddressIn,
  saveAddressIn,
  toAccountAddress,
  type AccountAddressRecord,
} from './account-addresses.js';
import { ACCOUNT_DATA, ACCOUNT_DATA_TYPE, accountDataKey } from './account-data.js';
import {
  addToWishlistIn,
  removeFromWishlistIn,
  wishlistIn,
  wishlistOwnerIn,
  type AccountList,
  type WishlistOwner,
} from './account-wishlist.js';
import { CartService } from './cart.service.js';
import { checkCodeIn, sendCodeIn } from './number-codes.js';

// Shoppers' accounts on a shop's storefront (CUS-02, ADR-570): a shopper signs in with their
// mobile number and a code sent to it, as at checkout (CHK-09), but a code of its own purpose,
// which places no order, as checkout's signs no one in. The code proved gives the browser a
// session: a random token for its cookie, of which the shop keeps only a digest, with the number
// it proved. Through it the storefront reads the account of the customer the number is now: their
// orders, numbers merged into them too, and their store credit. A number no customer has signs in
// all the same, to an account with nothing in it, so that signing in says nothing of who shops
// there. Signed in, a shopper asks for their own data, or its erasure, as the shop's staff would
// for them (CUS-05, ADR-572), through the customers module's own requests. Each order lists what
// it sold, for the storefront to put in their cart again (ADR-574), saying what can be had now as
// the cart would: its variant still the shop's, its product on sale, and not sold out. Their
// wishlist is kept with the account (ADR-575): the customer's, or the number's while it has none.

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
  /** The lines of each it reads, to buy again: as many as an order takes. */
  lines: 100,
  /** The changes of their store credit it lists, the newest first (ADR-668). */
  credits: 20,
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

/** A file of the shopper's own data kept for the day, as {@link AccountService} reads it. */
interface KeptExport {
  key: string;
  customerId: string;
  readyAt: Date;
  expiresAt: Date;
}

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
    private readonly storage: ObjectStorage,
    private readonly data: CustomerDataService,
    private readonly carts: CartService,
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
   * orders with the shop, their store credit in its currency, and what they asked of their own
   * data (ADR-572). Null without a session.
   */
  async account(shopId: string, token: string): Promise<AccountJson | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx): Promise<AccountJson | null> => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      const { currency } = await shopProfile(tx, shopId);
      const orders = session.customerId
        ? await accountOrdersIn(tx, shopId, session.customerId, {
            orders: ACCOUNT_SESSION.orders,
            lines: ACCOUNT_SESSION.lines,
          })
        : [];
      // Theirs from the store the shop moved from (ADR-786).
      const past = session.customerId
        ? await pastOrdersOfCustomerIn(tx, shopId, session.customerId, ACCOUNT_SESSION.orders)
        : [];
      const lines = await this.#linesIn(
        tx,
        shopId,
        orders.map((order) => order.items),
      );
      const credit = session.customerId
        ? await storeCreditOfCustomerIn(tx, shopId, session.customerId, currency)
        : { balance: 0n, expiring: null };
      const history = session.customerId
        ? await storeCreditHistoryOfCustomerIn(
            tx,
            shopId,
            session.customerId,
            currency,
            ACCOUNT_SESSION.credits,
          )
        : [];
      const kept = session.customerId ? await keptExportIn(tx, shopId, session.customerId) : null;
      const erasure = session.customerId
        ? await this.data.ownErasureIn(tx, shopId, session.customerId)
        : null;
      // Their subscriptions, each managed from its latest order's page (ADR-916).
      const subscriptions = session.customerId
        ? await subscriptionsOfCustomerIn(tx, shopId, session.customerId, ACCOUNT_SESSION.orders)
        : [];
      const names = await variantNamesIn(
        tx,
        shopId,
        subscriptions.flatMap((each) => each.lines.map((line) => line.variantId)),
      );
      // Their code to bring friends, while the shop's referral programme is on (ADR-809).
      const program = session.customerId ? await referralProgramIn(tx, shopId) : null;
      const code =
        program && session.customerId ? await referralCodeIn(tx, shopId, session.customerId) : null;
      const dataRequests: AccountDataRequestsJson = {
        available: session.customerId !== null,
        erasureWaitDays: ERASURE_WAIT_DAYS,
        export: kept && exportJson(kept),
        erasure: erasure && erasureJson(erasure),
      };
      return {
        phone: session.phone,
        name: session.name,
        orders: orders.map((order, index) => ({
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
          lines: lines[index]!,
        })),
        pastOrders: past.map((order) => ({
          id: toPublicId('pastOrder', order.id),
          name: order.name,
          placedAt: order.placedAt.toISOString(),
          cancelled: order.cancelledAt !== null,
          financialStatus: order.financialStatus?.toLowerCase() ?? null,
          fulfillmentStatus: order.fulfillmentStatus?.toLowerCase() ?? null,
          total: Number(order.total),
          currency: order.currency,
          itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
          lines: order.lines.map(({ title, variantTitle, quantity }) => ({
            title,
            variantTitle,
            quantity,
          })),
        })),
        storeCredit: {
          balance: Number(credit.balance),
          currency,
          expiring: credit.expiring && {
            amount: Number(credit.expiring.amount),
            expiresAt: credit.expiring.expiresAt.toISOString(),
          },
          history: history.map((entry) => ({
            kind: entry.kind,
            event: entry.kind === 'expiration' ? null : entry.event,
            amount: Number(entry.amount),
            balanceAfter: Number(entry.balanceAfter),
            at: entry.createdAt.toISOString(),
            expiresAt: entry.kind === 'credit' ? (entry.expiresAt?.toISOString() ?? null) : null,
            orderId: entry.orderId && toPublicId('order', entry.orderId),
          })),
        },
        dataRequests,
        subscriptions: subscriptions.map((each) => ({
          id: toPublicId('orderSubscription', each.id),
          status: each.status === 'paused' ? 'paused' : 'active',
          planName: each.planName,
          interval: { unit: each.intervalUnit, count: each.intervalCount },
          discountPercent: each.discountPercent,
          nextOrderOn: each.nextOrderOn,
          ordersPlaced: each.ordersPlaced,
          // A variant the shop has since removed is left out, as nothing of it is known.
          lines: each.lines.flatMap((line) => {
            const name = names.get(line.variantId);
            return name
              ? [
                  {
                    productTitle: name.productTitle,
                    variantTitle: name.variantTitle,
                    quantity: line.quantity,
                  },
                ]
              : [];
          }),
          orderId: toPublicId('order', each.lastOrderId ?? each.originOrderId),
        })),
        referral:
          program && code
            ? {
                code,
                referrerCredit: Number(program.referrerCredit),
                friendCredit: Number(program.friendCredit),
                currency,
              }
            : null,
      };
    });
  }

  /**
   * The file of the own data of the shopper whose session `token` names (CUS-05, ADR-572), with
   * a link that downloads it for {@link ACCOUNT_DATA}'s minutes: the customer's export, made as
   * the shop's staff make it, the audit log naming the customer as who asked, and kept by storage
   * for a day; the one kept given again until then, so a customer has one made a day at most.
   * `none` for a number no customer has, of whom the shop keeps nothing to give; null without a
   * session.
   */
  async dataExport(shopId: string, token: string): Promise<AccountDataExportResponse | null> {
    if (!TOKEN.test(token)) return null;
    // Put in storage before the transaction commits: let go again should it not.
    let stored: string | null = null;
    try {
      return await this.db.tenant(shopId, async (tx): Promise<AccountDataExportResponse | null> => {
        const session = await sessionIn(tx, shopId, token);
        if (!session) return null;
        const customerId = session.customerId;
        if (!customerId) return { state: 'none' };
        // One at a time for a customer, so that two asking at once have one file between them.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`account_data_export:${customerId}`}, 0))`);
        const kept = await keptExportIn(tx, shopId, customerId);
        if (kept) return { ...this.#linked(kept), made: false };
        // In a transaction of its own, which holds the customer as it reads them.
        const file = await this.data.exportOwn(shopId, customerId);
        // Erased since the session read them.
        if (!file.ok) return { state: 'none' };
        const id = newId();
        const key = accountDataKey(shopId, id);
        const body = Buffer.from(file.value.json);
        await this.storage.put(key, body, ACCOUNT_DATA_TYPE);
        stored = key;
        const { rows } = await tx.execute<{
          created_at: string | Date;
          expires_at: string | Date;
        }>(sql`
          INSERT INTO checkout.account_data_exports (shop_id, id, customer_id, key, size,
                                                     expires_at)
          VALUES (${shopId}, ${id}, ${customerId}, ${key}, ${body.length},
                  now() + ${`${ACCOUNT_DATA.keepHours} hours`}::interval)
          RETURNING created_at, expires_at`);
        const made = {
          key,
          customerId,
          readyAt: toDate(rows[0]!.created_at),
          expiresAt: toDate(rows[0]!.expires_at),
        };
        return { ...this.#linked(made), made: true };
      });
    } catch (error) {
      if (stored) await this.storage.delete(stored).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A new link to the file of their own data kept for the shopper whose session `token` names
   * (ADR-572), as {@link dataExport} gives one; null without a session, or a file kept.
   */
  async dataExportLink(
    shopId: string,
    token: string,
  ): Promise<Exclude<AccountDataExportResponse, { state: 'none' }> | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session?.customerId) return null;
      const kept = await keptExportIn(tx, shopId, session.customerId);
      return kept && { ...this.#linked(kept), made: false };
    });
  }

  /**
   * Asks for the erasure of the shopper whose session `token` names (CUS-05, ADR-572), as the
   * shop's staff would for them: in {@link ERASURE_WAIT_DAYS} days, unless the shop cancels it
   * first, the request, its event and the audit log naming the customer as who asked. Asking
   * again, or once the shop has, changes nothing. How it waits: held while an order of theirs is
   * open, or the shop owes them store credit. `none` for a number no customer has, of whom the
   * shop keeps nothing to erase; null without a session. They are told once it is done (ADR-582),
   * at the number their sign-in proved, in `locale` where it is one of the platform's languages,
   * else English.
   */
  async dataErase(
    shopId: string,
    token: string,
    locale?: string | null,
  ): Promise<AccountDataEraseResponse | null> {
    const session = await this.session(shopId, token);
    if (!session) return null;
    const customerId = session.customerId;
    if (!customerId) return { state: 'none' };
    // "ur", or "ur-PK" as a browser may name it.
    const asked = await this.data.requestOwnErasure(shopId, customerId, {
      phone: session.phone,
      language: (locale ?? '').split('-')[0]!.toLowerCase() === 'ur' ? 'ur' : 'en',
    });
    // Erased since the session read them.
    if (!asked.ok) return { state: 'none' };
    const erasure = await this.db.tenant(shopId, (tx) =>
      this.data.ownErasureIn(tx, shopId, customerId),
    );
    // Cancelled by the shop, or carried out, since: as before they asked.
    return erasure ? erasureJson(erasure) : { state: 'none' };
  }

  /**
   * The wishlist of the account the session `token` names (ADR-575): its products, the newest
   * first, by the catalog's IDs, those the shop no longer has left out. Null without a session.
   */
  async wishlist(shopId: string, token: string): Promise<string[] | null> {
    return this.#wishlist(shopId, token, async () => undefined);
  }

  /**
   * Adds `productIds`, the newest first, to the wishlist of the account the session `token` names
   * (ADR-575): those the shop has, each once, those already in it staying where they are, and the
   * oldest going past the 100 it keeps. The wishlist as it is now; null without a session.
   */
  async addToWishlist(
    shopId: string,
    token: string,
    productIds: readonly string[],
  ): Promise<string[] | null> {
    return this.#wishlist(shopId, token, (tx, owner) =>
      addToWishlistIn(tx, shopId, owner, productIds),
    );
  }

  /**
   * The products the account the session `token` names viewed (ADR-978), the latest first, those
   * the shop no longer has left out. Null without a session.
   */
  async recentlyViewed(shopId: string, token: string): Promise<string[] | null> {
    return this.#wishlist(shopId, token, async () => undefined, 'viewed');
  }

  /**
   * Adds `productIds`, the latest first, to the products the account the session `token` names
   * viewed (ADR-978): those the shop has, those viewed before moving to the top, the newest twenty
   * kept. The list as it is now; null without a session.
   */
  async addToRecentlyViewed(
    shopId: string,
    token: string,
    productIds: readonly string[],
  ): Promise<string[] | null> {
    return this.#wishlist(
      shopId,
      token,
      (tx, owner) => addToWishlistIn(tx, shopId, owner, productIds, 'viewed'),
      'viewed',
    );
  }

  /**
   * Takes the product `productId` off the wishlist of the account the session `token` names
   * (ADR-575): the wishlist as it is now; null without a session.
   */
  async removeFromWishlist(
    shopId: string,
    token: string,
    productId: string,
  ): Promise<string[] | null> {
    return this.#wishlist(shopId, token, (tx, owner) =>
      removeFromWishlistIn(tx, shopId, owner, productId),
    );
  }

  /**
   * The address book of the account the session `token` names (CUS-02, ADR-583): the default
   * first, then the latest changed; empty for a number no customer has yet. Null without a session.
   */
  async addresses(shopId: string, token: string): Promise<AccountAddress[] | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      if (!session.customerId) return [];
      return (await addressesIn(tx, shopId, session.customerId)).map(toAccountAddress);
    });
  }

  /**
   * The address books of the customers `customerIds`, for staff (ADR-588): by customer, the
   * default first, then the latest changed; none for one who keeps none.
   */
  async addressBooks(
    shopId: string,
    customerIds: readonly string[],
  ): Promise<Map<string, AccountAddressRecord[]>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(shopId, (tx) => addressBooksIn(tx, shopId, customerIds));
  }

  /**
   * Fills the address books of customers brought from another store (ONB-05, ADR-784), each
   * customer by their mobile number: their addresses checked as checkout's are, the one asked to
   * be the default, at most {@link ACCOUNT_ADDRESSES_MAX}. A book with addresses already, or a
   * number no customer has, is left as it is, so bringing them again adds none. How many
   * addresses were kept, and why each that was not, by its book's index.
   */
  async bringAddresses(
    shopId: string,
    books: readonly { phone: string; addresses: readonly AccountAddressRequest[] }[],
  ): Promise<{ added: number; problems: { book: number; message: string }[] }> {
    let added = 0;
    const problems: { book: number; message: string }[] = [];
    for (const [index, book] of books.entries()) {
      const phone = parsePkMobile(book.phone)?.e164;
      if (!phone || book.addresses.length === 0) continue;
      await this.db.tenant(shopId, async (tx) => {
        const customer = await customerOfPhoneIn(tx, shopId, phone);
        if (!customer || (await addressesIn(tx, shopId, customer.id)).length > 0) return;
        for (const input of book.addresses.slice(0, ACCOUNT_ADDRESSES_MAX)) {
          const check = new InputChecker();
          if (await saveAddressIn(tx, check, shopId, customer.id, input, null)) added++;
          else
            problems.push({ book: index, message: check.errors.map((e) => e.message).join('; ') });
        }
      });
    }
    return { added, problems };
  }

  /**
   * Saves `input` to the address book of the account the session `token` names (ADR-583): a new
   * address, or the one `addressId` names changed, checked as checkout's are. The book as it is
   * now, or what was wrong; a number no customer has yet keeps no book, its addresses coming with
   * its first order. Null without a session.
   */
  async saveAddress(
    shopId: string,
    token: string,
    input: AccountAddressRequest,
    addressId: string | null,
  ): Promise<
    | { kind: 'saved'; addresses: AccountAddress[] }
    | { kind: 'invalid'; errors: FieldError[] }
    | null
  > {
    if (!TOKEN.test(token)) return null;
    const id = addressId === null ? null : tryFromPublicId(addressId, 'accountAddress');
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      const check = new InputChecker();
      if (!session.customerId) {
        check.addMessage([], 'INVALID', 'Your addresses are kept once you place your first order');
        return { kind: 'invalid', errors: check.errors };
      }
      if (addressId !== null && !id) {
        check.add(['id'], 'NOT_FOUND', 'is not one of your addresses');
        return { kind: 'invalid', errors: check.errors };
      }
      const saved = await saveAddressIn(tx, check, shopId, session.customerId, input, id);
      if (!saved) return { kind: 'invalid', errors: check.errors };
      const book = await addressesIn(tx, shopId, session.customerId);
      return { kind: 'saved', addresses: book.map(toAccountAddress) };
    });
  }

  /**
   * Takes the address `addressId` out of the address book of the account the session `token`
   * names (ADR-583), the newest left becoming the default where it was: the book as it is now,
   * the same for an address not in it. Null without a session.
   */
  async deleteAddress(
    shopId: string,
    token: string,
    addressId: string,
  ): Promise<AccountAddress[] | null> {
    if (!TOKEN.test(token)) return null;
    const id = tryFromPublicId(addressId, 'accountAddress');
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      if (!session.customerId) return [];
      if (id) await deleteAddressIn(tx, shopId, session.customerId, id);
      return (await addressesIn(tx, shopId, session.customerId)).map(toAccountAddress);
    });
  }

  /**
   * The wishlist of the session `token` names once `change` changed it, or its products viewed
   * where `list` says so (ADR-978); null without one.
   */
  async #wishlist(
    shopId: string,
    token: string,
    change: (tx: Tx, owner: WishlistOwner) => Promise<void>,
    list: AccountList = 'wishlist',
  ): Promise<string[] | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session) return null;
      const owner = await wishlistOwnerIn(tx, shopId, session);
      await change(tx, owner);
      return wishlistIn(tx, shopId, owner, list);
    });
  }

  /** The file `kept`, with a link that downloads it for {@link ACCOUNT_DATA}'s minutes. */
  /**
   * What each order's `items` come to, to buy again (ADR-574), in the caller's transaction: each
   * as the cart names it, and whether the cart would take it now. Gift cards are left out: a
   * card is bought for someone, once. A bundle is bought again as itself, though its order keeps
   * only its parts: the shop's bundle sold as those parts, as many of each for as many of it, the
   * one of its title and on sale first; none once no bundle of the shop's is.
   */
  async #linesIn(
    tx: Tx,
    shopId: string,
    orders: readonly (readonly AccountOrderItemFacts[])[],
  ): Promise<AccountOrderLineJson[][]> {
    const items = orders.flat();
    const lines = items.flatMap((item) => (item.kind === 'line' ? [item] : []));
    const bundles = items.flatMap((item) => (item.kind === 'bundle' ? [item] : []));
    const giftCards = await giftCardProductIdsIn(
      tx,
      shopId,
      lines.map((line) => line.productId),
    );
    const parts = [
      ...new Set(bundles.flatMap((bundle) => bundle.parts.map((part) => part.productId))),
    ];
    const candidates =
      parts.length === 0
        ? []
        : [
            ...(
              await bundlesOfProductsIn(tx, shopId, await bundlesContainingIn(tx, shopId, parts))
            ).values(),
          ];
    const soldAs = new Map(
      bundles.map((bundle) => [bundle, candidates.filter((each) => sameParts(each, bundle))]),
    );
    const facts = await this.carts.factsIn(tx, shopId, [
      ...lines.map((line) => line.variantId),
      ...[...soldAs.values()].flat().map((each) => each.variantId),
    ]);
    const available = (variantId: string) => {
      const fact = facts.get(variantId);
      return !!fact?.forSale && (fact.sellable === null || fact.sellable > 0);
    };
    return orders.map((listed) =>
      listed.flatMap((item): AccountOrderLineJson[] => {
        if (item.kind === 'line') {
          if (giftCards.has(item.productId)) return [];
          return [
            {
              variantId: item.variantId,
              productTitle: item.title,
              variantTitle:
                item.variantTitle === DEFAULT_VARIANT_TITLE || item.variantTitle === ''
                  ? null
                  : item.variantTitle,
              quantity: item.quantity,
              available: available(item.variantId),
            },
          ];
        }
        const rank = (each: BundleRecord) =>
          (facts.get(each.variantId)?.title === item.title ? 2 : 0) +
          (available(each.variantId) ? 1 : 0);
        const chosen = soldAs
          .get(item)!
          .reduce<BundleRecord | null>(
            (best, each) => (best === null || rank(each) > rank(best) ? each : best),
            null,
          );
        return [
          {
            variantId: chosen?.variantId ?? null,
            productTitle: item.title,
            variantTitle: null,
            quantity: item.quantity,
            available: chosen !== null && available(chosen.variantId),
          },
        ];
      }),
    );
  }

  #linked(kept: KeptExport): AccountDataExportJson & { url: string } {
    return {
      ...exportJson(kept),
      url: this.storage.signDownload(kept.key, ACCOUNT_DATA.linkSeconds, {
        filename: `customer-${toPublicId('customer', kept.customerId)}.json`,
      }),
    };
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

/** The file of the customer `customerId`'s own data storage keeps, if it does (ADR-572). */
async function keptExportIn(
  tx: Tx,
  shopId: string,
  customerId: string,
): Promise<KeptExport | null> {
  const { rows } = await tx.execute<{
    key: string;
    created_at: string | Date;
    expires_at: string | Date;
  }>(sql`
    SELECT key, created_at, expires_at FROM checkout.account_data_exports
     WHERE shop_id = ${shopId} AND customer_id = ${customerId} AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key,
    customerId,
    readyAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

function exportJson(kept: KeptExport): AccountDataExportJson {
  return {
    state: 'ready',
    readyAt: kept.readyAt.toISOString(),
    expiresAt: kept.expiresAt.toISOString(),
  };
}

/** A customer's erasure waiting, as their account shows it: held while anything holds it. */
function erasureJson(erasure: OwnErasureRecord): AccountErasureJson {
  return {
    state: erasure.holds.length > 0 ? 'held' : 'waiting',
    requestedAt: erasure.request.requestedAt.toISOString(),
    eraseAfter: erasure.request.dueAt.toISOString(),
  };
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
export async function sessionIn(
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

/**
 * Whether the shop's `bundle` is the one an order sold as `sold`'s parts: those variants, and no
 * others, as many units of each as its parts hold for as many of it.
 */
function sameParts(
  bundle: BundleRecord,
  sold: Extract<AccountOrderItemFacts, { kind: 'bundle' }>,
): boolean {
  return (
    bundle.components.length === sold.parts.length &&
    bundle.components.every(
      (component) =>
        sold.parts.find((part) => part.variantId === component.variantId)?.units ===
        component.quantity * sold.quantity,
    )
  );
}
