import { createHash } from 'node:crypto';
import { InputChecker, PublicSite, StorefrontSite, shopProfile, type FieldError } from '@hatti/api';
import { DEFAULT_VARIANT_TITLE } from '@hatti/catalog/public';
import {
  recordCheckoutConsentIn,
  shopGivesStoreCreditIn,
  storeCreditOfPhoneIn,
  storeCreditPaidIn,
  type MarketingChannelValue,
} from '@hatti/customers/public';
import { secretToken, sha256 } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { LOGO_URL_SECONDS, shopLogoOf } from '@hatti/files/public';
import { newId } from '@hatti/ids';
import { MessagesService, type PhoneChannel } from '@hatti/messaging/public';
import type { CurrencyCode } from '@hatti/money';
import {
  shopAccentOf,
  shopPolicyVersionsOf,
  shopPreferencesOf,
  type PolicyVersionRef,
} from '@hatti/online-store/public';
import {
  ORDER_LIMITS,
  OnlinePayments,
  OrderService,
  attributionOf,
  bankTransferSettingsIn,
  cashPastLimitOf,
  checkAddress,
  codLimitError,
  offeredBankTransferIn,
  transferDiscountOf,
  transferOwed,
  type AttributionValue,
  type BankAccountValue,
  type BrowserIdsValue,
  type GatewayFormStart,
  type OnlineGateway,
  type OnlinePaymentProblem,
  type OrderRecord,
  type PaymentMethodValue,
  type TransferDiscountValue,
} from '@hatti/orders/public';
import {
  applyDiscountIn,
  discountCodeIn,
  discountFor,
  redeemDiscountIn,
  type DiscountCodeRecord,
  type DiscountRefusal,
} from '@hatti/pricing/public';
import { maskPkMobile } from '@hatti/pk';
import { ObjectStorage } from '@hatti/storage';
import type { CartJson } from '@hatti/storefront-api';
import { NO_TAX, taxSettingsIn, type TaxRates, type TaxSettingsRecord } from '@hatti/tax/public';
import { Injectable, Optional } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CartService } from './cart.service.js';
import {
  NO_COD_RULES,
  advanceAsksOfCustomers,
  advanceKeyOf,
  codRefusalOf,
  placedAdvanceOf,
  type CodAdvanceValue,
  type CodRefusal,
  type CodRulesRecord,
} from './cod-rules.js';
import { codRulesIn } from './cod-rules.service.js';
import { highestDeliveryCharge, type DeliverySettingsRecord } from './delivery.js';
import { DeliveryService } from './delivery.service.js';
import { marketingTicked, marketingWording } from './marketing.js';
import { checkoutMarketingIn } from './marketing.service.js';
import {
  checkCodeIn,
  numberVerifiedIn,
  provedByBrowserIn,
  proveBrowserIn,
  sendCodeIn,
  type CodeCheck,
} from './number-codes.js';
import { checkouts } from './schema.js';
import { checkoutTotals } from './totals.js';
import { trustBadgesIn } from './trust-badge.service.js';
import type { TrustBadgeValue } from './trust-badges.js';

/** Where checkouts' pages are on the core's address: /checkouts/<secret>, as `checkoutPagePath`. */
export const CHECKOUT_PATH = 'checkouts';

/** How long a checkout lasts from when the shopper starts it, its thank-you page with it. */
export const CHECKOUT_HOURS = 24;

/** 128 random bits in base64url, as carts' and links' secrets. */
const TOKEN_BYTES = 16;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** Expired checkouts deleted each time a shop gets a new one. */
const SWEEP = 100;

/**
 * Codes a checkout's page takes that take nothing off before it takes no more, so that codes
 * cannot be guessed.
 */
export const DISCOUNT_ATTEMPTS = 10;

/**
 * How many orders checkout takes from one mobile number a day, and from one internet address an
 * hour (CHK-18, ADR-087), so that a bot or a prankster can't flood a shop with orders, each
 * holding its stock. An address is shared by many phones on a mobile network, so it takes more.
 */
export const CHECKOUT_LIMITS = { ordersPerNumberDaily: 3, ordersPerAddressHourly: 20 } as const;

/** What the shopper typed on the page, every field as posted. */
export interface CheckoutForm {
  name: string;
  /** Their mobile number, which the courier and the shop call. */
  phone: string;
  /** An email the order's news goes to as well (MSG-01); blank, or absent, for none. */
  email?: string;
  city: string;
  /** The house and street. */
  address1: string;
  /** The area: "Gulshan-e-Iqbal". */
  address2: string;
  /** A place near it the rider can ask for: "near Jamia Masjid". */
  landmark: string;
  /** A province's code, or blank to take it from the city. */
  province: string;
  /**
   * How they chose to pay: "cash_on_delivery", "bank_transfer" or "online"; blank for the page's
   * default.
   */
  payment: string;
  /** The code sent to their number, where checkout asked for one (CHK-09). */
  code: string;
  /** "whatsapp" or "sms": a new code asked for, nothing placed; blank otherwise. */
  resend: string;
  /**
   * "1" to pay with the store credit the number has, once the shopper proves it is theirs with a
   * code (ADR-186); blank, or absent, not to.
   */
  storeCredit?: string;
  /**
   * The channels whose box for the shop's news and offers the shopper ticked, space-separated:
   * "whatsapp email" (ADR-187); blank, or absent, for none.
   */
  marketing?: string;
}

export const EMPTY_FORM: CheckoutForm = {
  name: '',
  phone: '',
  email: '',
  city: '',
  address1: '',
  address2: '',
  landmark: '',
  province: '',
  payment: '',
  code: '',
  resend: '',
  storeCredit: '',
  marketing: '',
};

/** Why cash on delivery can't take an order: the law's cap (TAX-07), or the shop's rules (CHK-07). */
export type CodUnavailable = { reason: 'law' } | CodRefusal;

/** How the page offers to pay for the cart (ADR-074, ADR-075, ADR-077). */
export interface CheckoutPayments {
  /**
   * Why cash on delivery can't take the cart, whatever the shopper types: its items alone come to
   * more than the law lets it collect, or than the shop takes it for; null when it may.
   */
  codRefusal: CodUnavailable | null;
  /** The shop's rules for cash on delivery, which the page states and placing checks. */
  codRules: CodRulesRecord;
  /** The account the shop's customers pay into, while it offers bank transfer. */
  bankTransfer: BankAccountValue | null;
  /**
   * What paying by transfer takes off the items, after any code, while the shop offers it
   * (CHK-08); null for nothing.
   */
  transferDiscount: TransferDiscountValue | null;
  /**
   * What cash on delivery asks for in advance by the shop's rules, paid by transfer into its
   * account (ADR-084); null for nothing, as where it has no account.
   */
  advance: CodAdvanceValue | null;
  /**
   * Whether cash on delivery asks in advance, by transfer into the shop's account, what an order
   * comes to past the law's cap (TAX-07, ADR-188): where the cart may come to more, wherever it
   * goes, and the shop has an account for advances.
   */
  capAdvance: boolean;
  /**
   * The shop's payment gateway, while it takes the cart's currency online (ADR-152): the order
   * placed waits for its total, which its thank-you page takes through it. Null otherwise.
   */
  online: OnlineGateway | null;
}

/** Why the order was not placed: the page shows the checkout again, with what the shopper typed. */
export type CheckoutProblem =
  /** The cart, or what delivery costs, changed after the page showed it. */
  | { kind: 'changed' }
  /** The address or number does not check out. */
  | { kind: 'address'; errors: FieldError[] }
  /** Some of the cart cannot be bought now, as when it sold out. */
  | { kind: 'unavailable' }
  /** It would collect more cash on delivery than the law allows an order (TAX-07). */
  | { kind: 'cod_limit' }
  /**
   * The shop's rules keep cash on delivery from it (CHK-07): its total, its city or its customer.
   * The page offers bank transfer, chosen for the shopper, where the shop takes it.
   */
  | { kind: 'cod_unavailable'; refusal: CodRefusal }
  /**
   * A discount code took nothing off: as it was typed or kept, and why; or the page has been
   * given too many that took nothing off.
   */
  | { kind: 'discount'; code: string; refusal: DiscountRefusal | { reason: 'attempts' } }
  /** The shop cannot take the order now, as when it has nowhere to send it from. */
  | { kind: 'refused' }
  /** The shopper asked to pay with store credit, and the number they proved has none (ADR-186). */
  | { kind: 'no_store_credit' }
  /**
   * Checkout took as many orders as it takes lately from the shopper's number, or from their
   * internet address (CHK-18).
   */
  | { kind: 'too_many'; by: 'phone' | 'address' }
  /**
   * The shop asks for a code sent to the number first (CHK-09, ADR-148): `phone`, masked, where
   * it went and how; then whether the one typed was wrong, too late, or one too many.
   */
  | {
      kind: 'code';
      phone: string;
      channel: PhoneChannel;
      state: 'sent' | Exclude<CodeCheck, 'verified' | 'none'>;
    };

export interface CheckoutShop {
  name: string;
  /** Its storefront's address, to go back to. */
  storefront: string;
  /**
   * The policies it has, in Shopify's order, by kind and current version: the page links them as
   * Shopify's checkout does, and placing the order agrees to them (ADR-057).
   */
  policies: readonly PolicyVersionRef[];
  /**
   * Its theme's accent colour, such as "#B45309", for the page's buttons and links (CHK-14); null
   * when the theme leaves it to the platform's.
   */
  accent: string | null;
  /**
   * Where its logo is shown, for an hour from when the page was made (ADR-081); null when it has
   * none, when the page shows its name.
   */
  logo: string | null;
  /** The badges it chose for the page, in their order (ADR-086). */
  badges: readonly TrustBadgeValue[];
  /** Its WhatsApp number in E.164, for the badge offering help there; null without one. */
  whatsapp: string | null;
}

/** The discount code the shopper applied: what it is now, or why it takes nothing off now. */
export type CheckoutDiscount =
  | { code: string; record: DiscountCodeRecord; refusal: null }
  | { code: string; record: null; refusal: DiscountRefusal };

/** Where the shopper placed the order from, as their browser told the storefront. */
export interface CheckoutClient {
  ip: string | null;
  userAgent: string | null;
  /** The IDs the shop's Meta pixel gave their browser, from its cookies (ADR-144). */
  browserIds?: BrowserIdsValue | null;
  /**
   * The token the browser's cookie keeps of a number it proved with a code at the shop's checkout
   * lately (ADR-199).
   */
  proof?: string | null;
}

export type CheckoutView =
  | { kind: 'not_found' }
  | { kind: 'expired'; shop: CheckoutShop }
  /** Its cart is empty, or gone. */
  | { kind: 'empty'; shop: CheckoutShop }
  | {
      kind: 'open';
      shop: CheckoutShop;
      cartId: string;
      cart: CartJson;
      delivery: DeliverySettingsRecord;
      /** The code the shopper applied, if any. */
      discount: CheckoutDiscount | null;
      payments: CheckoutPayments;
      /** The shop's sales tax, which the page says its total includes (ADR-096). */
      tax: TaxSettingsRecord;
      /** The digest of what the page shows, which its form carries. */
      shown: string;
      form: CheckoutForm;
      problem: CheckoutProblem | null;
      /**
       * Where the shopper came to the online store from, as the storefront passed it when they
       * began (ADR-139): for the order placed, not the page.
       */
      attribution: AttributionValue | null;
      /** Whether the page offers to pay with store credit: once the shop has given any (ADR-186). */
      storeCredit: boolean;
      /** The channels the page offers a box for the shop's news and offers on (ADR-187). */
      marketing: readonly MarketingChannelValue[];
    }
  | {
      kind: 'placed';
      shop: CheckoutShop;
      order: OrderRecord;
      /**
       * While it waits for its money and the shop takes it online (ADR-151, ADR-152): through
       * which gateway, and how much, in minor units.
       */
      online: { gateway: OnlineGateway; amount: bigint } | null;
      /**
       * How paying online went, as the shopper came back from the gateway: `paid` once its
       * payment is in; or why not.
       */
      payment: 'paid' | OnlinePaymentProblem | null;
      /** What of it store credit paid, in minor units (ADR-186). */
      storeCredit: bigint;
      /**
       * The form that takes the shopper on to the shop's gateway, once they asked to pay online
       * and its page takes one, as JazzCash's does (ADR-163).
       */
      gatewayForm?: GatewayFormStart;
      /**
       * For the browser's cookie, once the order's number was proved by a code here: its next
       * checkouts at the shop need not ask again for it (ADR-199).
       */
      proof?: string;
    };

/**
 * Checkouts (ADR-044): a shopper's cart becomes an order on a page of the core's, at an address
 * carrying a secret of its own, paid on delivery or, where the shop gives its account, by bank
 * transfer (ADR-074), with what the shop takes off for it (ADR-077). Nothing the shopper types is
 * kept until the order has it.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: Database,
    private readonly carts: CartService,
    private readonly delivery: DeliveryService,
    private readonly orders: OrderService,
    private readonly storefronts: StorefrontSite,
    private readonly storage: ObjectStorage,
    /** Sends the codes that prove shoppers' numbers (CHK-09). */
    private readonly messages: MessagesService,
    /** Paying online through the shop's gateway (ADR-152); without it, no paying online. */
    @Optional() private readonly payments?: OnlinePayments,
    /** Where shoppers come back to from the gateway: the core's own address. */
    @Optional() private readonly site?: PublicSite,
  ) {}

  /**
   * Starts a checkout for the cart `cartToken` names: the secret its page's address carries; null
   * when the cart is gone, or holds nothing that can be bought. `visits` are those the storefront
   * knew of that brought the shopper (ADR-139), kept, as checked, for the order placed.
   */
  async start(shopId: string, cartToken: string, visits?: unknown): Promise<string | null> {
    const attribution = attributionOf(visits, new Date());
    return this.db.tenant(shopId, async (tx) => {
      const cart = await this.carts.findIn(tx, shopId, cartToken);
      if (!cart || (await this.carts.priceIn(tx, shopId, cart)).items.length === 0) return null;
      await tx.execute(sql`
        DELETE FROM checkout.checkouts
         WHERE shop_id = ${shopId}
           AND id IN (SELECT id FROM checkout.checkouts
                       WHERE shop_id = ${shopId} AND expires_at < now()
                       LIMIT ${SWEEP})`);
      const secret = secretToken('', TOKEN_BYTES);
      await tx.insert(checkouts).values({
        shopId,
        id: newId(),
        tokenHash: sha256(secret),
        cartId: cart.id,
        attribution,
        expiresAt: sql`now() + ${`${CHECKOUT_HOURS} hours`}::interval`,
      });
      return secret;
    });
  }

  /** What the checkout's page shows; with `shopId`, only for that shop's checkouts. */
  async view(token: string, shopId?: string): Promise<CheckoutView> {
    const found = await this.#resolve(token, shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, (tx) => this.#view(tx, found, false, EMPTY_FORM));
  }

  /**
   * Places the order as the page showed it (`shown`), to the address and number the shopper typed,
   * paid as they chose of the ways the page offered: on delivery, its risk scored as for any such
   * order, with the shop's fee for it, and none placed at the shop's limit for risk (ADR-099); or
   * by bank transfer, waiting for the money, less what the shop takes off for it (ADR-077). With the shop's delivery charge for their city and its stock
   * committed, and what the shopper agreed to kept with it: the versions of the shop's policies
   * the page linked, and where `client` placed it from (ADR-057). A discount code the shopper
   * applied goes with it, and its use is counted with the order: a code used up since, or used
   * before by a customer meant to use it once, places nothing (ADR-063). Then the cart is emptied.
   * Placing twice places one order; what stops it shows the page again, saying why. With
   * `shopId`, only for that shop's checkouts.
   */
  async place(
    token: string,
    shown: string,
    form: CheckoutForm,
    options: { shopId?: string; client?: CheckoutClient } = {},
  ): Promise<CheckoutView> {
    const { shopId, client } = options;
    const found = await this.#resolve(token, shopId);
    if (!found) return { kind: 'not_found' };
    // A new code asked for: sent, and nothing placed.
    if (form.resend === 'whatsapp' || form.resend === 'sms') {
      return this.#sendCode(found, form, form.resend);
    }
    // A code typed: the order goes on only once it is the one sent.
    if (form.code.trim() !== '') {
      const refused = await this.#checkCode(found, form);
      if (refused) return refused;
    }
    try {
      return await this.#place(found, shown, form, client);
    } catch (error) {
      // The shop asks for a code first, or the shopper's store credit does: the order is
      // undone, and one sent on WhatsApp.
      if (error instanceof NeedsCode) return this.#sendCode(found, form, 'whatsapp');
      if (!(error instanceof DiscountRefused) && !(error instanceof RefusedForRisk)) throw error;
      // The order is undone; the page says why, with what the shopper typed.
      return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
        const view = await this.#view(tx, found, false, form);
        if (view.kind !== 'open') return view;
        if (error instanceof DiscountRefused) {
          return {
            ...view,
            problem: { kind: 'discount', code: error.code, refusal: error.refusal },
          };
        }
        // A transfer, or paying online, where the shop takes it, is chosen for the shopper's
        // next post.
        return {
          ...view,
          form: { ...form, payment: prepaidChoiceOf(view.payments, form.payment) },
          problem: { kind: 'cod_unavailable', refusal: { reason: 'risk' } },
        };
      });
    }
  }

  /**
   * Sends a code to the number typed, on `channel`, for the shopper to prove it (CHK-09): the page
   * again, asking for it. Nothing is placed.
   */
  async #sendCode(
    found: { shopId: string; checkoutId: string },
    form: CheckoutForm,
    channel: PhoneChannel,
  ): Promise<CheckoutView> {
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const typed = { ...form, code: '', resend: '' };
      const view = await this.#view(tx, found, false, typed);
      if (view.kind !== 'open') return view;
      const check = new InputChecker();
      const address = checkAddress(check, [], { ...form, zip: null });
      if (!address) return { ...view, problem: { kind: 'address', errors: check.errors } };
      const sent = await sendCodeIn(tx, this.messages, {
        shopId: found.shopId,
        checkoutId: found.checkoutId,
        phone: address.phone,
        channel,
        shop: view.shop.name,
      });
      return {
        ...view,
        problem: {
          kind: 'code',
          phone: maskPkMobile(address.phone),
          channel,
          state: sent === 'sent' ? 'sent' : 'too_many',
        },
      };
    });
  }

  /**
   * Checks the code typed against the one sent to the number typed: null once it is proved, the
   * page again saying what is wrong otherwise.
   */
  async #checkCode(
    found: { shopId: string; checkoutId: string },
    form: CheckoutForm,
  ): Promise<CheckoutView | null> {
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView | null> => {
      const check = new InputChecker();
      const address = checkAddress(check, [], { ...form, zip: null });
      // The address is checked as the order is placed.
      if (!address) return null;
      const checked = await checkCodeIn(
        tx,
        found.shopId,
        found.checkoutId,
        address.phone,
        form.code,
      );
      if (checked === 'verified') return null;
      const view = await this.#view(tx, found, false, { ...form, code: '', resend: '' });
      if (view.kind !== 'open') return view;
      const { rows } = await tx.execute<{ channel: PhoneChannel }>(sql`
        SELECT channel FROM checkout.number_codes
         WHERE shop_id = ${found.shopId} AND checkout_id = ${found.checkoutId}
           AND phone = ${address.phone}
         ORDER BY created_at DESC
         LIMIT 1`);
      return {
        ...view,
        problem: {
          kind: 'code',
          phone: maskPkMobile(address.phone),
          channel: rows[0]?.channel ?? 'whatsapp',
          // None sent to this number: its own has gone, as when the number changed.
          state: checked === 'none' ? 'expired' : checked,
        },
      };
    });
  }

  async #place(
    found: { shopId: string; checkoutId: string },
    shown: string,
    form: CheckoutForm,
    client: CheckoutClient | undefined,
  ): Promise<CheckoutView> {
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, form);
      if (view.kind !== 'open' || view.problem) return view;
      if (view.shown !== shown) return { ...view, problem: { kind: 'changed' } };
      // A way to pay the page no longer offers, or never did.
      const paymentMethod = paymentOf(form.payment, view.payments);
      if (!paymentMethod) return { ...view, problem: { kind: 'changed' } };
      const check = new InputChecker();
      const address = checkAddress(check, [], { ...form, zip: null });
      const email = check.email(['email'], form.email)?.toLowerCase() ?? null;
      if (!address || !check.ok) {
        return { ...view, problem: { kind: 'address', errors: check.errors } };
      }
      if (view.cart.items.some((item) => item.maxQuantity !== null)) {
        return { ...view, problem: { kind: 'unavailable' } };
      }
      // Not more orders lately from the number, or the internet address, than checkout takes.
      const recent = await this.orders.checkoutOrdersFrom(tx, found.shopId, {
        phone: address.phone,
        ip: client?.ip ?? null,
      });
      if (recent.phoneDay >= CHECKOUT_LIMITS.ordersPerNumberDaily) {
        return { ...view, problem: { kind: 'too_many', by: 'phone' } };
      }
      if (recent.ipHour >= CHECKOUT_LIMITS.ordersPerAddressHourly) {
        return { ...view, problem: { kind: 'too_many', by: 'address' } };
      }
      const profile = await shopProfile(tx, found.shopId);
      const code = view.discount?.record ?? null;
      const totals = checkoutTotals(BigInt(view.cart.subtotal), view.delivery, address.city, code);
      // Known once the city is.
      const delivery = totals.delivery!;
      const shipping = totals.freeDelivery ? 0n : delivery;
      // The parcels the customer with the number typed refused before, and those the shop
      // delivered to them, where the shop's rules for paying on delivery, or its advance, ask
      // (ADR-075, ADR-089, ADR-094).
      const rules = view.payments.codRules;
      // Store credit, where the shopper asked to pay with it and the page offered it (ADR-186).
      const withCredit = view.storeCredit && form.storeCredit === '1';
      // Whether the number was proved with a code here, where the shop asks for one (ADR-148), or
      // the shopper would spend its store credit.
      const asksCode = paymentMethod === 'cash_on_delivery' && rules.verifyFromScore !== null;
      const codedAt =
        withCredit || asksCode
          ? await numberVerifiedIn(tx, found.shopId, found.checkoutId, address.phone)
          : null;
      // Or proved in this browser lately (ADR-199): enough where the shop's risk rules ask, never
      // to spend the number's credit.
      const verifiedAt =
        codedAt ??
        (asksCode && client?.proof
          ? await provedByBrowserIn(tx, found.shopId, client.proof, address.phone)
          : null);
      if (withCredit) {
        // The number's credit is the shopper's to spend once they prove it is theirs.
        if (!codedAt) throw new NeedsCode();
        const credit = await storeCreditOfPhoneIn(
          tx,
          found.shopId,
          address.phone,
          profile.currency,
        );
        if (credit === 0n) {
          return {
            ...view,
            form: { ...form, storeCredit: '' },
            problem: { kind: 'no_store_credit' },
          };
        }
      }
      const customer =
        paymentMethod === 'cash_on_delivery' &&
        (rules.refusedDeliveriesLimit !== null || advanceAsksOfCustomers(view.payments.advance))
          ? await this.orders.deliveriesOf(tx, found.shopId, address.phone)
          : undefined;
      if (paymentMethod === 'cash_on_delivery') {
        const refusal = codRefusalOf(rules, {
          total: totals.total!,
          city: address.city,
          refused: customer?.refused,
        });
        if (refusal) {
          // A transfer, or paying online, where the shop takes it, is chosen for the shopper's
          // next post.
          return {
            ...view,
            form: { ...form, payment: prepaidChoiceOf(view.payments, form.payment) },
            problem: { kind: 'cod_unavailable', refusal },
          };
        }
      }
      // What the shop takes off for paying by transfer, which the page stated (CHK-08): off the
      // items after the code. Delivery is what it was: free delivery's threshold is the code's.
      const transferDiscount =
        paymentMethod === 'bank_transfer'
          ? transferDiscountOf(
              view.payments.transferDiscount,
              totals.subtotal - totals.discount,
              profile.currency as CurrencyCode,
            )
          : 0n;
      const advance =
        paymentMethod === 'cash_on_delivery'
          ? placedAdvanceOf(
              view.payments.advance,
              {
                items: totals.subtotal - totals.discount,
                delivery: shipping,
                city: address.city,
                refused: customer?.refused,
                delivered: customer?.delivered,
              },
              profile.currency as CurrencyCode,
            )
          : { due: 0n, ifRisky: null };
      // Past the law's cap, what the order comes to past it is asked in advance as well, where
      // the page said so (ADR-188): the larger of the two, whatever the order's risk, which an
      // order asked for an advance isn't scored for.
      const pastLimit =
        paymentMethod === 'cash_on_delivery' && view.payments.capAdvance
          ? cashPastLimitOf({
              currency: profile.currency,
              total: totals.subtotal - totals.discount + shipping + rules.fee,
            })
          : 0n;
      const asked =
        pastLimit > 0n
          ? { due: advance.due > pastLimit ? advance.due : pastLimit, ifRisky: null }
          : advance;
      const placed = await this.orders.placeIn(
        tx,
        {
          shopId: found.shopId,
          currency: profile.currency as CurrencyCode,
          actor: 'system',
          source: 'online_store',
          how: verifiedAt
            ? 'from the online store, its number proved with a code'
            : 'from the online store',
        },
        {
          field: [],
          // At the prices the page showed, which its digest says are the catalog's now.
          lines: view.cart.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            price: BigInt(item.price),
          })),
          address,
          email,
          paymentMethod,
          shipping,
          discount: totals.discount + transferDiscount,
          transferDiscount,
          discountCodes: code ? [code.code] : [],
          advance: 0n,
          // The shop's fee for paying at the door, which the page stated (CHK-08).
          codFee: paymentMethod === 'cash_on_delivery' ? view.payments.codRules.fee : 0n,
          // And what it asks for in advance, which the page stated too (ADR-084), where and of
          // whom the shop asks it (ADR-089); or, by the order's risk, only if placing scores it
          // that high, instead of holding it for review (ADR-094).
          advanceDue: asked.due,
          riskAdvance: asked.ifRisky,
          locationId: null,
          note: orderNoteOf(view.cart),
          tags: [],
          agreement: {
            policyVersions: view.shop.policies.map((policy) => policy.versionId),
            ip: client?.ip ?? null,
            userAgent: client?.userAgent ?? null,
          },
          attribution: view.attribution,
          browserIds: client?.browserIds ?? null,
          phoneVerifiedAt: verifiedAt,
        },
      );
      if (!placed.ok) {
        const codes = new Set(placed.errors.map((error) => error.code));
        const problem = codes.has('COD_LIMIT')
          ? 'cod_limit'
          : codes.has('OUT_OF_STOCK') || codes.has('NOT_FOUND')
            ? 'unavailable'
            : 'refused';
        return { ...view, problem: { kind: problem } };
      }
      // Scored at the shop's limit or above, it is not taken paid on delivery (ADR-099): undone,
      // as a refused code undoes it, for the page to ask for a transfer instead.
      const limit = rules.riskScoreLimit;
      if (
        paymentMethod === 'cash_on_delivery' &&
        limit !== null &&
        (placed.value.risk?.score ?? 0) >= limit
      ) {
        throw new RefusedForRisk();
      }
      // Scored where the shop asks for a code, and its number not proved: undone, for a code.
      const verifyFrom = rules.verifyFromScore;
      if (
        paymentMethod === 'cash_on_delivery' &&
        verifyFrom !== null &&
        (placed.value.risk?.score ?? 0) >= verifyFrom &&
        !verifiedAt
      ) {
        throw new NeedsCode();
      }
      if (code) {
        const redeemed = await redeemDiscountIn(tx, found.shopId, {
          codeId: code.id,
          orderId: placed.value.id,
          customerId: placed.value.customerId,
          amount: totals.discount + (totals.freeDelivery ? delivery : 0n),
        });
        if (!redeemed.ok) throw new DiscountRefused(code.code, redeemed.refusal);
      }
      // The shopper's store credit pays what it can of it (ADR-186).
      const storeCredit = withCredit
        ? await this.orders.payPlacedWithStoreCreditIn(tx, found.shopId, placed.value.id)
        : 0n;
      // The boxes ticked for the shop's news and offers, as the page worded them (ADR-187).
      const ticked = marketingTicked(form.marketing, view.marketing);
      if (ticked.length > 0) {
        await recordCheckoutConsentIn(tx, found.shopId, {
          customerId: placed.value.customerId,
          phone: address.phone,
          email: placed.value.email,
          ticked: ticked.map((channel) => ({
            channel,
            wording: marketingWording(view.shop.name, channel),
          })),
        });
      }
      await tx
        .update(checkouts)
        .set({ orderId: placed.value.id, completedAt: sql`now()` })
        .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
      await this.carts.emptyIn(tx, found.shopId, view.cartId);
      const order =
        storeCredit > 0n
          ? ((await this.orders.orderOf(tx, found.shopId, placed.value.id)) ?? placed.value)
          : placed.value;
      // Proved by a code here: the browser is spared one for the number for a while (ADR-199).
      const proof = codedAt
        ? await proveBrowserIn(tx, found.shopId, address.phone, codedAt)
        : undefined;
      return {
        kind: 'placed',
        shop: view.shop,
        order,
        online: null,
        payment: null,
        storeCredit,
        ...(proof && { proof }),
      };
    });
  }

  async #view(
    tx: Tx,
    found: { shopId: string; checkoutId: string },
    lock: boolean,
    form: CheckoutForm,
  ): Promise<CheckoutView> {
    const { shopId, checkoutId } = found;
    const query = tx
      .select()
      .from(checkouts)
      .where(and(eq(checkouts.shopId, shopId), eq(checkouts.id, checkoutId)));
    const [checkout] = lock ? await query.for('update') : await query;
    if (!checkout) return { kind: 'not_found' };
    const profile = await shopProfile(tx, shopId);
    const logo = await shopLogoOf(tx, shopId);
    const badges = await trustBadgesIn(tx, shopId);
    const shop = {
      name: profile.name,
      storefront: this.storefronts.url(profile.handle),
      policies: await shopPolicyVersionsOf(tx, shopId),
      accent: await shopAccentOf(tx, shopId),
      logo: logo && this.storage.signDownload(logo.key, LOGO_URL_SECONDS),
      badges,
      whatsapp: badges.some((badge) => badge.kind === 'whatsapp')
        ? (await shopPreferencesOf(tx, shopId)).whatsappNumber
        : null,
    };
    // An expired checkout shows nothing, its thank-you page's address included.
    if (checkout.expiresAt <= new Date()) return { kind: 'expired', shop };
    if (checkout.orderId) {
      const order = await this.orders.orderOf(tx, shopId, checkout.orderId);
      if (!order) return { kind: 'not_found' };
      // What it waits for before it ships, which the shop's gateway may take online (ADR-152).
      const owed =
        order.status === 'open' && order.stage === 'awaiting_payment' ? transferOwed(order) : 0n;
      const gateway =
        owed > 0n && this.payments
          ? await this.payments.gatewayOf(tx, shopId, order.currency)
          : null;
      return {
        kind: 'placed',
        shop,
        order,
        online: gateway && { gateway, amount: owed },
        payment: null,
        storeCredit: await storeCreditPaidIn(tx, shopId, order.id),
      };
    }
    const cart = checkout.cartId
      ? await this.carts.cartIn(tx, shopId, checkout.cartId, lock)
      : null;
    if (!cart) return { kind: 'empty', shop };
    const priced = await this.carts.priceIn(tx, shopId, cart);
    if (priced.items.length === 0) return { kind: 'empty', shop };
    const delivery = await this.delivery.settingsOf(tx, shopId);
    const [typed] = cart.discountCodes;
    const discount =
      typed === undefined ? null : await discountOn(tx, shopId, typed, BigInt(priced.subtotal));
    const totals = checkoutTotals(
      BigInt(priced.subtotal),
      delivery,
      null,
      discount?.record ?? null,
    );
    // Items that alone come to more than cash on delivery may collect, by law or by the shop's
    // rules, or hold a product the shop takes it for none of, are paid by transfer, or cannot be
    // ordered here.
    const items = totals.subtotal - totals.discount;
    const overLimit = codLimitError([], {
      paymentMethod: 'cash_on_delivery',
      currency: profile.currency,
      total: items,
      advance: 0n,
    });
    const codRules = await codRulesIn(tx, shopId);
    // Whether the order may come to more than the law lets cash on delivery collect, wherever it
    // goes: with the dearest delivery and the fee.
    const mayPassLimit =
      cashPastLimitOf({
        currency: profile.currency,
        total:
          items +
          (totals.freeDelivery ? 0n : highestDeliveryCharge(delivery, items)) +
          codRules.fee,
      }) > 0n;
    // The cart's products, by their tags, where the shop keeps cash on delivery from some.
    const products =
      codRules.unavailableProductTags.length === 0
        ? []
        : await this.carts.productsIn(tx, shopId, priced);
    const transfer = await offeredBankTransferIn(tx, shopId);
    // The shop's gateway, where it takes the shop's currency online (ADR-152).
    const online = this.payments
      ? await this.payments.gatewayOf(tx, shopId, profile.currency as CurrencyCode)
      : null;
    // An advance is paid into the shop's account, which it may give without offering transfers:
    // the shop's own, or what the order comes to past the law's cap (ADR-188).
    const account =
      codRules.advance === null && !mayPassLimit
        ? null
        : (transfer?.account ?? (await bankTransferSettingsIn(tx, shopId)).account);
    const payments: CheckoutPayments = {
      codRefusal:
        overLimit && !account
          ? { reason: 'law' }
          : codRefusalOf(codRules, { total: items, products }),
      codRules,
      bankTransfer: transfer?.account ?? null,
      transferDiscount: transfer?.discount ?? null,
      advance: account ? codRules.advance : null,
      capAdvance: mayPassLimit && account !== null,
      online,
    };
    const { codRefusal } = payments;
    const tax = await taxSettingsIn(tx, shopId);
    return {
      kind: 'open',
      shop,
      cartId: cart.id,
      cart: priced,
      delivery,
      discount,
      payments,
      tax,
      shown: shownOf(priced, delivery, shop.policies, discount, payments, tax),
      form,
      attribution: checkout.attribution,
      storeCredit: await shopGivesStoreCreditIn(tx, shopId),
      marketing: await checkoutMarketingIn(tx, shopId),
      problem:
        !codRefusal || payments.bankTransfer || payments.online
          ? null
          : codRefusal.reason === 'law'
            ? { kind: 'cod_limit' }
            : { kind: 'cod_unavailable', refusal: codRefusal },
    };
  }

  /**
   * Applies the code the shopper typed to the checkout's cart, if it takes something off the
   * items now (or delivery, once the city is known); otherwise says why, and counts the attempt:
   * past {@link DISCOUNT_ATTEMPTS}, the page takes no more codes. With `shopId`, only for that
   * shop's checkouts.
   */
  async applyDiscount(
    token: string,
    typed: string,
    options: { shopId?: string } = {},
  ): Promise<CheckoutView> {
    const found = await this.#resolve(token, options.shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, EMPTY_FORM);
      if (view.kind !== 'open') return view;
      const shown = typed.trim().slice(0, 64);
      const [checkout] = await tx
        .select({ attempts: checkouts.discountAttempts })
        .from(checkouts)
        .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
      if ((checkout?.attempts ?? 0) >= DISCOUNT_ATTEMPTS) {
        return {
          ...view,
          problem: { kind: 'discount', code: shown, refusal: { reason: 'attempts' } },
        };
      }
      const applied = await applyDiscountIn(tx, found.shopId, typed, {
        subtotal: BigInt(view.cart.subtotal),
        shipping: 0n,
      });
      if (!applied.ok) {
        await tx
          .update(checkouts)
          .set({ discountAttempts: sql`${checkouts.discountAttempts} + 1` })
          .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
        return { ...view, problem: { kind: 'discount', code: shown, refusal: applied.refusal } };
      }
      await this.carts.setDiscountCodesIn(tx, found.shopId, view.cartId, [applied.code.code]);
      return this.#view(tx, found, false, EMPTY_FORM);
    });
  }

  /** Takes the discount code off the checkout's cart. */
  async removeDiscount(token: string, options: { shopId?: string } = {}): Promise<CheckoutView> {
    const found = await this.#resolve(token, options.shopId);
    if (!found) return { kind: 'not_found' };
    return this.db.tenant(found.shopId, async (tx): Promise<CheckoutView> => {
      const view = await this.#view(tx, found, true, EMPTY_FORM);
      if (view.kind !== 'open') return view;
      await this.carts.setDiscountCodesIn(tx, found.shopId, view.cartId, []);
      return this.#view(tx, found, false, EMPTY_FORM);
    });
  }

  /**
   * The shopper asked, on the thank-you page, to pay online what their order waits for (ADR-152):
   * the shop's gateway's page to send them to, or the page again saying why not. They come back
   * to the checkout's `paid` address on the core's own site, wherever the page was, since the
   * gateway sends them back from another site; and to its page if they give up. With `shopId`,
   * only for that shop's checkouts.
   */
  async payOnline(
    token: string,
    options: { shopId?: string } = {},
  ): Promise<{ url: string } | CheckoutView> {
    const found = await this.#resolve(token, options.shopId);
    if (!found) return { kind: 'not_found' };
    const view = await this.db.tenant(found.shopId, (tx) =>
      this.#view(tx, found, false, EMPTY_FORM),
    );
    if (view.kind !== 'placed' || !view.online || !this.payments || !this.site) return view;
    const page = this.site.url(`/${CHECKOUT_PATH}/${token}`);
    const started = await this.payments.start(found.shopId, view.order.id, {
      returnUrl: `${page}/paid`,
      cancelUrl: page,
    });
    if (!('url' in started)) return { ...view, payment: 'unavailable' };
    return started.form
      ? { ...view, gatewayForm: { url: started.url, form: started.form } }
      : started;
  }

  /**
   * The shopper came back from the shop's gateway with `form`, as it sent them: the thank-you
   * page, saying the payment is in once the gateway says so, here or by its webhook, or that it
   * waits to hear, or that it was a test.
   */
  async paidOnline(token: string, form: Readonly<Record<string, string>>): Promise<CheckoutView> {
    const found = await this.#resolve(token, undefined);
    if (!found) return { kind: 'not_found' };
    const orderId = await this.db.tenant(found.shopId, async (tx) => {
      const [checkout] = await tx
        .select({ orderId: checkouts.orderId })
        .from(checkouts)
        .where(and(eq(checkouts.shopId, found.shopId), eq(checkouts.id, found.checkoutId)));
      return checkout?.orderId ?? null;
    });
    const outcome =
      orderId && this.payments ? await this.payments.returned(found.shopId, orderId, form) : null;
    return paidNoticeOf(await this.view(token), outcome);
  }

  /**
   * The shop and checkout a secret names, whatever the shop, since the core's page knows no shop;
   * a storefront's is for its own shop's.
   */
  async #resolve(
    token: string,
    shopId: string | undefined,
  ): Promise<{ shopId: string; checkoutId: string } | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; checkout_id: string }>(
      sql`SELECT * FROM checkout.resolve_checkout(${sha256(token)})`,
    );
    const row = rows[0];
    if (!row || (shopId !== undefined && row.shop_id !== shopId)) return null;
    return { shopId: row.shop_id, checkoutId: row.checkout_id };
  }
}

/**
 * A digest of what the page shows: the cart's lines at their prices, its note, what delivery
 * costs, the versions of the policies it links, the discount code, as it was when shown and
 * whether it took anything off, the bank a transfer goes to, if one is offered, and what paying
 * so takes off, what the shop's rules keep cash on delivery to, and its fee. The order is placed
 * only as the page showed it, and agrees only to what it linked.
 */
export function shownOf(
  cart: CartJson,
  delivery: DeliverySettingsRecord,
  policies: readonly PolicyVersionRef[],
  discount: CheckoutDiscount | null = null,
  payments: Pick<CheckoutPayments, 'codRules' | 'bankTransfer' | 'transferDiscount'> &
    Partial<Pick<CheckoutPayments, 'advance' | 'capAdvance' | 'online'>> = {
    codRules: NO_COD_RULES,
    bankTransfer: null,
    transferDiscount: null,
  },
  tax: TaxRates = NO_TAX,
): string {
  const { maxOrderTotal, unavailableCities, fee } = payments.codRules;
  const off = payments.bankTransfer ? payments.transferDiscount : null;
  const facts = {
    items: cart.items.map((item) => [item.key, item.quantity, item.price]),
    note: cart.note,
    delivery: [
      delivery.charge.toString(),
      delivery.freeAbove?.toString() ?? null,
      delivery.zones.map((zone) => [zone.cities, zone.charge.toString()]),
    ],
    policies: policies.map((policy) => policy.versionId),
    discount: discount && [
      discount.code,
      discount.record ? [discount.record.id, discount.record.version] : discount.refusal.reason,
    ],
    // Each left out while there is none, so that what pages without it showed stays as it was.
    ...(payments.bankTransfer && { bankTransfer: payments.bankTransfer.bankName }),
    ...(off && {
      transferDiscount:
        off.kind === 'percentage'
          ? [off.percentageBps, off.cap?.toString() ?? null]
          : off.amount.toString(),
    }),
    ...((maxOrderTotal !== null || unavailableCities.length > 0) && {
      cod: [maxOrderTotal?.toString() ?? null, unavailableCities],
    }),
    ...(fee > 0n && { codFee: fee.toString() }),
    ...(payments.advance && { codAdvance: advanceKeyOf(payments.advance) }),
    ...(payments.capAdvance && { codCapAdvance: true }),
    // Through which gateway the page offers to pay online (ADR-152).
    ...(payments.online && { online: payments.online.name }),
    // The tax the page says the total includes, at which rates, and which items it is in.
    ...(tax.rate !== null && {
      tax: [
        tax.rate,
        tax.taxDelivery,
        (tax.categories ?? []).map((category) => [category.code, category.rate]),
        cart.items.map((item) => [item.taxable, item.taxCode]),
      ],
    }),
  };
  return createHash('sha256').update(JSON.stringify(facts)).digest('base64url').slice(0, 22);
}

/**
 * How the shopper pays: as they chose, if the page offered it; on delivery by default, else by
 * transfer, else online, as the page offers them. Null for a way the page did not offer.
 */
function paymentOf(choice: string, payments: CheckoutPayments): PaymentMethodValue | null {
  const { bankTransfer, online } = payments;
  const cashOnDelivery = payments.codRefusal === null;
  switch (choice) {
    case 'cash_on_delivery':
      return cashOnDelivery ? 'cash_on_delivery' : null;
    case 'bank_transfer':
      return bankTransfer ? 'bank_transfer' : null;
    case 'online':
      return online ? 'online' : null;
    case '':
      return cashOnDelivery
        ? 'cash_on_delivery'
        : bankTransfer
          ? 'bank_transfer'
          : online
            ? 'online'
            : null;
    default:
      return null;
  }
}

/**
 * What the page chooses for the shopper once cash on delivery can't take the order: what they
 * chose, if it was paying before; else a transfer, where the shop takes it; else paying online.
 */
function prepaidChoiceOf(payments: CheckoutPayments, chosen: string): string {
  if (
    (chosen === 'bank_transfer' && payments.bankTransfer) ||
    (chosen === 'online' && payments.online)
  ) {
    return chosen;
  }
  return payments.bankTransfer ? 'bank_transfer' : payments.online ? 'online' : chosen;
}

/**
 * The thank-you page once the shopper is back from paying online: `outcome` as the gateway's
 * return said it; else waiting to hear while the order still waits for its money, or paid if
 * something was paid on it and it waits for nothing more, as when its webhook came first.
 */
export function paidNoticeOf(view: CheckoutView, outcome: 'paid' | 'test' | null): CheckoutView {
  if (view.kind !== 'placed') return view;
  if (outcome) return { ...view, payment: outcome };
  if (view.online) return { ...view, payment: 'pending' };
  return view.order.status === 'open' && view.order.amountPaid > 0n
    ? { ...view, payment: 'paid' }
    : view;
}

/** An order paid on delivery whose number the shop asks to be proved with a code first. */
class NeedsCode extends Error {
  constructor() {
    super("The shop asks for a code sent to the order's number first");
    this.name = 'NeedsCode';
  }
}

/** A code a customer may not use, met as their order is placed: the order is undone. */
/** An order paid on delivery that the shop's risk rules scored at its limit or above. */
class RefusedForRisk extends Error {
  constructor() {
    super("The order's risk is at the shop's limit for cash on delivery");
    this.name = 'RefusedForRisk';
  }
}

class DiscountRefused extends Error {
  constructor(
    readonly code: string,
    readonly refusal: DiscountRefusal,
  ) {
    super(`The discount code ${code} was refused: ${refusal.reason}`);
    this.name = 'DiscountRefused';
  }
}

/** The code `typed` a cart keeps, as it is now for items coming to `subtotal`. */
async function discountOn(
  tx: Tx,
  shopId: string,
  typed: string,
  subtotal: bigint,
): Promise<CheckoutDiscount> {
  const record = await discountCodeIn(tx, shopId, typed);
  if (!record) return { code: typed, record: null, refusal: { reason: 'unknown' } };
  const applied = discountFor(record, { subtotal, shipping: 0n });
  return applied.ok
    ? { code: record.code, record, refusal: null }
    : { code: record.code, record: null, refusal: applied.refusal };
}

/** "Peshawari Chappal (8)"; a product without options by its title alone. */
export function itemName(title: string, variantTitle: string): string {
  return variantTitle === DEFAULT_VARIANT_TITLE ? title : `${title} (${variantTitle})`;
}

/**
 * The properties of a line the shopper sees, such as an engraving's text. Those whose names start
 * with "_" are for apps, and hidden, as on Shopify.
 */
export function shownProperties(properties: Record<string, string>): [string, string][] {
  return Object.entries(properties).filter(([name]) => !name.startsWith('_'));
}

/**
 * The order's note: the cart's, then each line's properties, which orders keep no other way, cut
 * to what an order's note holds.
 */
export function orderNoteOf(cart: CartJson): string {
  const lines = cart.items.flatMap((item) => {
    const properties = shownProperties(item.properties);
    if (properties.length === 0) return [];
    const values = properties.map(([name, value]) => `${name}: ${value}`).join(', ');
    return [`${item.quantity} × ${itemName(item.title, item.variantTitle)}: ${values}`];
  });
  const note = [cart.note.trim(), ...lines].filter((part) => part !== '').join('\n');
  const max = ORDER_LIMITS.note;
  return note.length <= max ? note : `${note.slice(0, max - 1)}…`;
}
