import { isIP } from 'node:net';
import {
  INPUT_LIMITS,
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  shopProfile,
  type Actor,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import {
  VariantService,
  bundlesOfVariantsIn,
  isStitched,
  stitchingIn,
  type VariantSnapshot,
} from '@hatti/catalog/public';
import {
  BlocklistService,
  CustomerService,
  blockReasonText,
  debitStoreCreditIn,
  giftCardOfIn,
  giftCardsPaidIn,
  spendGiftCardIn,
  withdrawOrderCreditIn,
  storeCreditAccountsIn,
  storeCreditPaidIn,
  type BlocklistEntryRecord,
} from '@hatti/customers/public';
import { Database, executePrepared, literalLimit, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, appendEvents, recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import {
  LocationService,
  StockService,
  preordersIn,
  type LocationRecord,
} from '@hatti/inventory/public';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { orderTaxOf, taxSettingsIn } from '@hatti/tax/public';
import { Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { checkAddress, type AddressInput } from './address.js';
import { toAttributionRecord, type AttributionValue } from './attribution.js';
import { bankTransferSettingsIn } from './bank-transfer.service.js';
import { browserIdsOf, type BrowserIdsValue } from './browser-ids.js';
import { cardsBackText, creditBackText, giveCardsBackIn, giveCreditBackIn } from './credit-back.js';
import { customerFactsQuery } from './customer-facts.js';
import { endDutyIn, shareOutIn } from './desk-duty.js';
import {
  OrderEvents,
  type OrderAssignedPayload,
  type OrderCancelledPayload,
  type OrderConfirmedPayload,
  type OrderCreatedPayload,
  type OrderPaidPayload,
  type OrderPaymentRemindedPayload,
  type OrderConfirmationRemindedPayload,
  type OrderConfirmationCalledPayload,
  type OrderUpdatedPayload,
  type PlanOrdersCountedPayload,
} from './events.js';
import { OVER_LIMIT_MESSAGE, planMonthIn, planOrderOf } from './plan-orders.js';
import { toTimelineEntry, type TimelineRow } from './order-comment.service.js';
import { orderConditions, type OrderFilter } from './order-filter.js';
import { callingWindowsIn, isCallingTime } from './calling-hours.js';
import {
  CONFIRMATION_CALL,
  CONFIRMATION_REMINDER,
  UNPAID_LIMITS,
  UNREACHABLE_LIMITS,
  orderSettingsIn,
} from './order-settings.service.js';
import { assessOrderRisk, riskColumns } from './order-risk.js';
import {
  actorColumns,
  addTimelineEntry,
  loadOrder,
  loadOrders,
  lockOrder,
  nextOrderNumber,
  orderReference,
  parcelSummary,
  searchTextOf,
  updateOrder,
  voidedStatusOf,
} from './order-store.js';
import { parcelWorth } from './parcel-claims.js';
import type {
  CustomerOrderStats,
  DeliverySlotValue,
  OrderAttributionRecord,
  OrderEventRecord,
  OrderHome,
  OrderRecord,
  OrderTally,
  Page,
} from './records.js';
import {
  advanceForRiskMessage,
  heldForRiskMessage,
  holdsForRisk,
  rescoredMessage,
  type RiskAssessment,
} from './risk.js';
import {
  LIMITS,
  advanceRefusal,
  codLimitError,
  orderName,
  stageOf,
  transferOwed,
} from './rules.js';
import { OnlinePayments } from './online-payments.js';
import {
  ORDER_STAGES,
  lines,
  orderComments,
  orderEvents,
  orders,
  type AddressValue,
  type CancelReasonValue,
  type ConfirmationStatusValue,
  type DeliveryMethodValue,
  type OrderRow,
  type OrderSourceValue,
  type OrderStageValue,
  type PaymentMethodValue,
  type StoredAddressValue,
} from './schema.js';
import { shareBundlePrice } from './bundle-lines.js';
import { stitchedShipsOn } from './stitched.js';

export interface OrderLineInput {
  variantId: string;
  quantity: number;
  /** Replaces the variant's price, e.g. one agreed in chat. Decimal, in major units. */
  price?: string | null;
}

export interface OrderCreateInput {
  lineItems: OrderLineInput[];
  shippingAddress: AddressInput;
  email?: string | null;
  /** Cash on delivery unless given. */
  paymentMethod?: PaymentMethodValue | null;
  /** Paid in advance on a cash-on-delivery order, such as the delivery charge. */
  advancePaid?: string | null;
  /**
   * Asked for in advance on a cash-on-delivery order, by transfer to the shop's account, before it
   * ships (ADR-083): it waits for it, and the courier collects the rest.
   */
  advanceDue?: string | null;
  shippingPrice?: string | null;
  discount?: string | null;
  /** Where it ships from, and where its stock is committed; chosen (ADR-355) if left out. */
  locationId?: string | null;
  /**
   * Shipped unless given; or collected at `locationId`, which must offer pickup (SHP-15,
   * ADR-389), or the one location that does when left out.
   */
  deliveryMethod?: DeliveryMethodValue | null;
  note?: string | null;
  /** The message to go with it as a gift (CHK-16, ADR-413). */
  giftMessage?: string | null;
  tags?: string[] | null;
}

/** A line as it is placed: a bundle's part keeps the bundle it was sold as (ADR-410). */
interface PlacingLine {
  variantId: string;
  quantity: number;
  price: bigint | null;
  /** As the order names them; a bundle's parts each keep the bundle's (ADR-687). */
  properties?: Record<string, string>;
  /** Where the order names it, for errors: a part's is its bundle's. */
  field: string[];
  bundle: { key: string; title: string; quantity: number } | null;
}

/** An order to place, checked: an orderCreate's, or a draft's items at the prices agreed. */
export interface OrderToPlace {
  /** Where its fields are in the request, for errors: ["input"] for orderCreate's. */
  field: string[];
  lines: {
    variantId: string;
    quantity: number;
    /** Replaces the variant's price; minor units. */
    price: bigint | null;
    /** What the shopper wrote or chose for it, as its cart's line had them (ADR-687). */
    properties?: Record<string, string>;
  }[];
  address: AddressValue;
  email: string | null;
  paymentMethod: PaymentMethodValue;
  /** Minor units. */
  shipping: bigint;
  discount: bigint;
  /** Paid in advance already. */
  advance: bigint;
  /**
   * Asked for in advance, by transfer, before it ships (ADR-083); cash on delivery only, and not
   * with `advance`.
   */
  advanceDue?: bigint;
  /**
   * Asked for in advance only if the shop's risk rules score the order `from` (1 to 100) or more
   * as it is placed, instead of holding it for review (ADR-094); cash on delivery only, and not
   * with `advance` or `advanceDue`.
   */
  riskAdvance?: { due: bigint; from: number } | null;
  /** What it charges for paying on delivery, as checkout adds it (CHK-08); cash on delivery only. */
  codFee?: bigint;
  /**
   * Of `discount`, what is taken off for paying by bank transfer, as checkout takes it (CHK-08,
   * ADR-077); bank transfer only.
   */
  transferDiscount?: bigint;
  /** Of `discount`, what is taken off for paying online, as checkout takes it (ADR-222). */
  onlineDiscount?: bigint;
  /** Where it ships from; chosen (ADR-355) if null. */
  locationId: string | null;
  /**
   * Shipped, as unless given; or collected at its location, which must offer pickup (ADR-389),
   * with no delivery charge.
   */
  deliveryMethod?: DeliveryMethodValue;
  note: string;
  /** The message to go with it as a gift, checked (CHK-16, ADR-413); none when left out. */
  giftMessage?: string | null;
  /** The day checkout said to expect delivery by (ADR-595), YYYY-MM-DD; none when left out. */
  deliveryExpectedOn?: string | null;
  /** The time the shopper chose at checkout to have it delivered in (ADR-769); none when left out. */
  deliverySlot?: DeliverySlotValue | null;
  tags: string[];
  /**
   * What its customer agreed to, when they place it themselves: through checkout (ADR-057), or by
   * confirming its draft through the draft's link (ADR-114).
   */
  agreement?: OrderAgreementInput | null;
  /**
   * The discount codes `discount` and `shipping` take account of, as the shop wrote them;
   * counting their uses is the caller's.
   */
  discountCodes?: string[];
  /** The automatic discounts `discount` takes account of, by their titles (ADR-515). */
  automaticDiscounts?: string[];
  /**
   * Where its customer came to the online store from before placing it, as checkout kept it
   * (ADR-139), checked by `attributionOf`.
   */
  attribution?: AttributionValue | null;
  /**
   * The IDs the shop's Meta pixel gave its customer's browser, as checkout passed them (MKT-10,
   * ADR-144); those not in Meta's format are left out.
   */
  browserIds?: BrowserIdsValue | null;
  /** When its customer proved its number with a code, as checkout asked (CHK-09, ADR-148). */
  phoneVerifiedAt?: Date | null;
}

/** An order's e-contract log, as checkout or a link gives it (ADR-057, ADR-114, ADR-115). */
export interface OrderAgreementInput {
  /** The versions of the shop's policies the page linked; none when it had none. */
  policyVersions: string[];
  /** The customer's address and browser, as Shopify's client details; kept only if well formed. */
  ip: string | null;
  userAgent: string | null;
}

/** Who places an order for which shop, and how, for its source and timeline. */
export interface Placement {
  shopId: string;
  currency: CurrencyCode;
  /**
   * Who to record in the timeline and stock history: the caller, or Hatti itself when a customer
   * confirms a draft through its link.
   */
  actor: Actor | 'system';
  source: OrderSourceValue;
  /** How the timeline says it was placed: "by staff", or "from draft #D2 by staff". */
  how: string;
  /** Set when the customer confirmed it already, through a draft's link. */
  confirmedByCustomer?: boolean;
  /**
   * False for an order that is not a sale of its own, as an exchange: it never counts toward the
   * orders its shop's plan allows in a month (ADR-263).
   */
  countsTowardPlan?: boolean;
}

/** Fields left out stay as they are. */
export interface OrderUpdateInput {
  /** Replaces the whole address. Only before anything has shipped. */
  shippingAddress?: AddressInput | null;
  /** null clears it. */
  email?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

/** An update's values, checked; those left out stay as they are. */
export interface CheckedOrderUpdate {
  address?: AddressValue;
  email?: string | null;
  note?: string;
  tags?: string[];
}

export interface ListOrdersOptions extends OrderFilter {
  first: number;
  after?: string | null;
}

export interface CancelOptions {
  reason: CancelReasonValue;
  /** Why, for the timeline. */
  staffNote?: string | null;
}

/** What a bulk action did: the orders now as asked, and why the others are not. */
export interface BulkResult {
  /** In the order given; orders that failed are left out. */
  orders: OrderRecord[];
  /** One or more per order that failed, at its place in the IDs: ["ids", "3"]. */
  errors: FieldError[];
}

/** How the timeline says an order is paid. */
const PAYMENT_METHOD_TEXT: Record<PaymentMethodValue, string> = {
  cash_on_delivery: 'cash on delivery',
  prepaid: 'paid in advance',
  bank_transfer: 'by bank transfer',
  online: 'to pay online',
};

const CANCEL_REASON_TEXT: Record<CancelReasonValue, string> = {
  customer: 'the customer cancelled',
  no_response: 'the customer could not be reached',
  fraud: 'the order looked fraudulent',
  inventory: 'the items were out of stock',
  other: 'other reasons',
  merged: 'it was merged into another order',
  unpaid: 'it was not paid',
  duplicate: 'it repeats another order of its customer',
};

/**
 * How many days back an order of the same customer, not shipped yet, may be the one a new order
 * repeats (CHK-11, ADR-392).
 */
export const REPEAT_DAYS = 3;

/**
 * The latest order of `customerId` placed in the last {@link REPEAT_DAYS} days, open and with
 * nothing shipped, that has any of `variantIds`: the one a new order may repeat; null for none.
 */
async function repeatedOrderIn(
  tx: Tx,
  shopId: string,
  customerId: string,
  variantIds: readonly string[],
): Promise<{ id: string; number: number; createdAt: Date } | null> {
  if (variantIds.length === 0) return null;
  const { rows } = await tx.execute<{ id: string; number: number; created_at: string | Date }>(sql`
    SELECT o.id, o.number, o.created_at
      FROM orders.orders o
     WHERE o.shop_id = ${shopId} AND o.customer_id = ${customerId}
       AND o.status = 'open' AND o.fulfillment_status = 'unfulfilled'
       AND o.created_at > now() - make_interval(days => ${REPEAT_DAYS})
       AND EXISTS (
             SELECT 1 FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id
                AND l.variant_id = ANY(${sql.param([...variantIds])}::uuid[]))
     ORDER BY o.created_at DESC
     LIMIT 1`);
  const [row] = rows;
  return row ? { id: row.id, number: row.number, createdAt: new Date(row.created_at) } : null;
}

/** How long ago `at` was, as a timeline says it: "20 minutes before", "2 days before". */
function sinceText(at: Date): string {
  const minutes = Math.max(1, Math.round((Date.now() - at.getTime()) / 60_000));
  if (minutes < 60) return minutes === 1 ? 'a minute before' : `${minutes} minutes before`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour before' : `${hours} hours before`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'a day before' : `${days} days before`;
}

/** Why orderCancel and orderBulkCancel take no `merged`: merging moves an order's items too. */
const MERGED_ONLY_BY_MERGING =
  'An order is merged into another with orderMerge, which gives it its items';

/**
 * Why an order from a blocked number waits for review, for its timeline. Timeline messages hold no
 * contact details, so erasing a customer leaves them as they are.
 */
function heldMessage(entry: BlocklistEntryRecord): string {
  return (
    `Held for review: the number is on the blocklist for ${blockReasonText(entry.reason)}` +
    (entry.note ? ` (${entry.note})` : '')
  );
}

/** The source of an order a caller creates directly: staff enter them, apps send them. */
function sourceOf(tenant: TenantContext): OrderSourceValue {
  return tenant.actor.kind === 'staff' ? 'manual' : 'api';
}

/**
 * Orders: placing them, confirming cash-on-delivery orders, cancelling, editing and recording
 * payment. Placing an order commits its stock at its location in the same transaction, so an order
 * exists only if its stock does; cancelling gives the stock back. Every order belongs to the
 * customer with its mobile number, and waits for review if the number is on the blocklist.
 * Cash-on-delivery orders are scored for how likely they are to come back unpaid, and wait for
 * review at the shop's threshold; bank-transfer orders wait for their money (ADR-074).
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
    private readonly locations: LocationService,
    private readonly stock: StockService,
    private readonly customers: CustomerService,
    private readonly blocklist: BlocklistService,
    /** Whether the shop takes payments online, for orders paid so (ADR-152). */
    @Optional() private readonly payments?: OnlinePayments,
    /** The orders a month the shop's plan allows (ADR-263); without it, as in most tests, any. */
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async create(
    tenant: TenantContext,
    input: OrderCreateInput,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const lineInputs = input.lineItems;
    if (lineInputs.length === 0)
      check.add(['input', 'lineItems'], 'BLANK', 'must include at least one');
    if (lineInputs.length > LIMITS.lines) {
      check.add(['input', 'lineItems'], 'TOO_MANY', `can have at most ${LIMITS.lines}`);
    }
    const checkedLines = lineInputs.map((line, index) => {
      const field = ['input', 'lineItems', String(index)];
      return {
        variantId: line.variantId,
        quantity: check.integer([...field, 'quantity'], line.quantity, {
          min: 1,
          max: LIMITS.quantity,
        }),
        price: check.price([...field, 'price'], line.price, tenant.currency),
      };
    });
    const address = checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
    const email = check.email(['input', 'email'], input.email);
    const paymentMethod = input.paymentMethod ?? 'cash_on_delivery';
    const shipping =
      check.price(['input', 'shippingPrice'], input.shippingPrice, tenant.currency) ?? 0n;
    const discount = check.price(['input', 'discount'], input.discount, tenant.currency) ?? 0n;
    const advance = check.price(['input', 'advancePaid'], input.advancePaid, tenant.currency) ?? 0n;
    const advanceDue =
      check.price(['input', 'advanceDue'], input.advanceDue, tenant.currency) ?? 0n;
    const noAdvance = advanceRefusal(paymentMethod);
    if (noAdvance && advance > 0n) {
      check.addMessage(['input', 'advancePaid'], 'INVALID', noAdvance);
    }
    if (noAdvance && advanceDue > 0n) {
      check.addMessage(['input', 'advanceDue'], 'INVALID', noAdvance);
    } else if (advance > 0n && advanceDue > 0n) {
      check.addMessage(
        ['input', 'advanceDue'],
        'INVALID',
        'Ask for an advance, or give the one paid already: not both',
      );
    }
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    const giftMessage = check.text(['input', 'giftMessage'], input.giftMessage, {
      max: LIMITS.giftMessage,
    });
    const tags = check.tags(['input', 'tags'], input.tags);
    if (!check.ok || !address) return { ok: false, errors: check.errors };

    const order: OrderToPlace = {
      field: ['input'],
      lines: checkedLines.map((line) => ({ ...line, quantity: line.quantity! })),
      address,
      email,
      paymentMethod,
      shipping,
      discount,
      advance,
      advanceDue,
      locationId: input.locationId ?? null,
      deliveryMethod: input.deliveryMethod ?? 'shipping',
      note,
      giftMessage,
      tags,
    };
    const placement: Placement = {
      shopId: tenant.shopId,
      currency: tenant.currency,
      actor: tenant.actor,
      source: sourceOf(tenant),
      how: tenant.actor.kind === 'staff' ? 'by staff' : 'through the API',
    };
    return this.db.tenant(tenant.shopId, (tx) => this.placeIn(tx, placement, order));
  }

  /**
   * Places a checked order in the caller's transaction, as {@link create} describes: drafts are
   * placed through it too, at the prices agreed. Nothing is written when it returns errors.
   */
  async placeIn(
    tx: Tx,
    placement: Placement,
    order: OrderToPlace,
  ): Promise<MutationResult<OrderRecord>> {
    const { shopId, currency } = placement;
    const { address, email, paymentMethod, shipping, discount, advance } = order;
    const askedAhead = order.advanceDue ?? 0n;
    const riskAdvance = order.riskAdvance ?? null;
    if (
      (askedAhead > 0n || riskAdvance) &&
      (paymentMethod !== 'cash_on_delivery' || advance > 0n)
    ) {
      throw new Error('Only a cash-on-delivery order with nothing paid asks for an advance');
    }
    if (askedAhead > 0n && riskAdvance) {
      throw new Error('An order asks for an advance whatever its risk, or by it: not both');
    }
    // Paid online through one of the shop's gateways, which it must have (ADR-152).
    if (
      paymentMethod === 'online' &&
      !(this.payments && (await this.payments.gatewaysOf(tx, shopId, currency)).length > 0)
    ) {
      return failOne(
        [...order.field, 'paymentMethod'],
        'INVALID',
        'The shop takes no payments online: connect a payment gateway account first',
      );
    }
    const deliveryMethod = order.deliveryMethod ?? 'shipping';
    const pickupAt =
      deliveryMethod === 'pickup' ? await this.#pickupLocation(tx, shopId, order) : null;
    if (pickupAt && !pickupAt.ok) return { ok: false, errors: [pickupAt.error] };
    if (deliveryMethod === 'pickup' && shipping > 0n) {
      return failOne(
        [...order.field, 'shippingPrice'],
        'INVALID',
        'An order the customer picks up has no delivery charge',
      );
    }
    const lineField = (index: number) => [...order.field, 'lineItems', String(index)];
    const asked = await this.variants.snapshotsOf(
      tx,
      shopId,
      order.lines.map((line) => line.variantId),
    );
    // A bundle is sold as its parts (ADR-410).
    const placing = await this.#parts(tx, shopId, order.lines, lineField, asked);
    const snapshots = placing.snapshots;
    const location = await this.#location(
      tx,
      shopId,
      pickupAt?.ok ? pickupAt.value : order.locationId,
      [...order.field, 'locationId'],
      placing.lines,
      // Routed by where it goes (ADR-839), where it goes anywhere.
      deliveryMethod === 'shipping' ? address : null,
    );
    const errors: FieldError[] = [];
    if (!location.ok) errors.push(location.error);
    order.lines.forEach((line, index) => {
      const snapshot = asked.get(line.variantId);
      if (!snapshot) {
        errors.push({
          field: [...lineField(index), 'variantId'],
          code: 'NOT_FOUND',
          message: 'Variant not found',
        });
      } else if (snapshot.productStatus === 'archived') {
        errors.push({
          field: [...lineField(index), 'variantId'],
          code: 'INVALID',
          message: `"${snapshot.productTitle}" is archived, so it can't be sold`,
        });
      }
    });
    errors.push(...placing.errors);
    if (errors.length > 0 || !location.ok) return { ok: false, errors };

    const priced = placing.lines.map((line, index) => {
      const snapshot = snapshots.get(line.variantId)!;
      const unitPrice = line.price ?? snapshot.price;
      return { ...line, snapshot, unitPrice, position: index + 1 };
    });
    const subtotal = priced.reduce((sum, line) => sum + line.unitPrice * BigInt(line.quantity), 0n);
    if (discount > subtotal) {
      return failOne(
        [...order.field, 'discount'],
        'INVALID',
        "The discount can't be more than the items cost",
      );
    }
    const codFee = order.codFee ?? 0n;
    if (codFee > 0n && paymentMethod !== 'cash_on_delivery') {
      throw new Error('Only an order paid on delivery has a fee for it');
    }
    const transferDiscount = order.transferDiscount ?? 0n;
    if (transferDiscount > 0n && paymentMethod !== 'bank_transfer') {
      throw new Error('Only an order paid by bank transfer has a discount for it');
    }
    if (transferDiscount > discount) {
      throw new Error("The discount for paying by transfer is part of the order's discount");
    }
    const onlineDiscount = order.onlineDiscount ?? 0n;
    if (onlineDiscount > 0n && paymentMethod !== 'online') {
      throw new Error('Only an order paid online has a discount for it');
    }
    if (onlineDiscount > discount) {
      throw new Error("The discount for paying online is part of the order's discount");
    }
    const total = subtotal - discount + shipping + codFee;
    // The sales tax its prices include, at the shop's rates now (ADR-096, ADR-097): on what was
    // paid for each line, after its share of the discount, at its tax code's rate or the shop's,
    // and on its charges where the shop's include it.
    const tax = orderTaxOf(await taxSettingsIn(tx, shopId), {
      lines: priced.map((line) => ({
        total: line.unitPrice * BigInt(line.quantity),
        taxable: line.snapshot.taxable,
        taxCode: line.snapshot.taxCode,
      })),
      discount,
      charges: shipping + codFee,
    });
    if (advance > total || askedAhead > total || (riskAdvance?.due ?? 0n) > total) {
      return failOne(
        [...order.field, advance > total ? 'advancePaid' : 'advanceDue'],
        'INVALID',
        "The advance can't be more than the total",
      );
    }
    // Cash at the door is what the advance, paid or asked for, leaves; one asked by the order's
    // risk may not be, so the cash is all of it.
    const overLimit = codLimitError(
      [...order.field, askedAhead > 0n ? 'advanceDue' : 'advancePaid'],
      {
        paymentMethod,
        currency,
        total,
        advance: advance + askedAhead,
      },
    );
    if (overLimit) return { ok: false, errors: [overLimit] };
    const amountPaid = paymentMethod === 'prepaid' ? total : advance;
    // The account its customer is told to pay into, the order or its advance, as it is now: a
    // later change of account leaves what they were told as it was.
    const account =
      paymentMethod === 'bank_transfer' || askedAhead > 0n || riskAdvance
        ? (await bankTransferSettingsIn(tx, shopId)).account
        : null;
    if ((askedAhead > 0n || riskAdvance) && !account) {
      return failOne(
        [...order.field, 'advanceDue'],
        'INVALID',
        "Asking for an advance needs the shop's bank account, which its customer pays it into",
      );
    }

    // Stock first: an order exists only if its stock does.
    const orderId = newId();
    const committed = await this.stock.commit(
      tx,
      { shopId, actor: placement.actor },
      priced.map((line) => ({
        variantId: line.variantId,
        locationId: location.value.id,
        quantity: line.quantity,
      })),
      { referenceDocumentUri: orderReference(orderId) },
    );
    if (!committed.ok) {
      return {
        ok: false,
        errors: committed.shortages.map((shortage) => {
          const line = priced.find((candidate) => candidate.variantId === shortage.variantId)!;
          const left = Math.max(shortage.available, 0);
          return {
            field: [...line.field, 'quantity'],
            code: 'OUT_OF_STOCK',
            message:
              left === 0
                ? `"${line.snapshot.productTitle}" is out of stock at ${location.value.name}`
                : `Only ${left} of "${line.snapshot.productTitle}" left at ${location.value.name}`,
          };
        }),
      };
    }

    // Then its customer, and whether the number is blocked. Customers come after stock in
    // every transaction that touches both, so that none waits on another in a cycle.
    const customerId = await this.customers.findOrCreate(tx, shopId, {
      phone: address.phone,
      name: address.name,
      email,
    });
    const blocked = await this.blocklist.entryOf(tx, shopId, address.phone);
    // An order of the same customer not shipped yet, placed in the days before with items in
    // common: this one may repeat it, for staff to merge, cancel or keep (CHK-11, ADR-392).
    const repeatOf = await repeatedOrderIn(
      tx,
      shopId,
      customerId,
      priced.map((line) => line.variantId),
    );
    // An advance paid by transfer is the customer's say-so, as paying is: nothing to score.
    const scored =
      paymentMethod === 'cash_on_delivery' && askedAhead === 0n
        ? await assessOrderRisk(tx, shopId, {
            orderId,
            splitFromId: null,
            customerId,
            total,
            currency,
            units: priced.reduce((sum, line) => sum + line.quantity, 0),
            address,
          })
        : null;
    const risk = scored?.assessment ?? null;
    // An order scored as high as the shop's advance says is asked for it, instead of being held
    // for review (ADR-094); it keeps its score, which says why.
    const askedForRisk =
      riskAdvance !== null && risk !== null && risk.score >= riskAdvance.from
        ? riskAdvance.due
        : 0n;
    const advanceDue = askedAhead + askedForRisk;
    const bankAccount = paymentMethod === 'bank_transfer' || advanceDue > 0n ? account : null;
    const risky =
      scored !== null &&
      askedForRisk === 0n &&
      holdsForRisk(scored.settings, scored.assessment.score);
    // Paying, before or by transfer, is the customer's say-so, and so is an advance: only cash on
    // delivery without one is confirmed.
    const confirmationStatus: ConfirmationStatusValue =
      blocked || risky
        ? 'needs_review'
        : paymentMethod !== 'cash_on_delivery' || advanceDue > 0n
          ? 'not_required'
          : placement.confirmedByCustomer
            ? 'confirmed'
            : 'pending';

    const statuses = {
      status: 'open' as const,
      packedAt: null,
      confirmationStatus,
      financialStatus:
        amountPaid === total
          ? ('paid' as const)
          : amountPaid > 0n
            ? ('partially_paid' as const)
            : ('pending' as const),
      fulfillmentStatus: 'unfulfilled' as const,
    };
    const number = await nextOrderNumber(tx, shopId);
    // Counted under the shop's order counter, taken just now: no other order of the shop counts
    // meanwhile (ADR-263).
    const limit =
      placement.countsTowardPlan === false
        ? null
        : ((await this.allowance?.limitIn(tx, shopId, 'ordersPerMonth')) ?? null);
    const planMonth = limit ? await planMonthIn(tx, shopId) : null;
    const planOrder = limit && planMonth ? planOrderOf(limit, planMonth.counted) : null;
    const [row] = await tx
      .insert(orders)
      .values({
        shopId,
        id: orderId,
        number,
        source: placement.source,
        planMonth: planMonth?.month ?? null,
        overLimitAt: planOrder?.overLimit ? sql`now()` : null,
        ...statuses,
        stage: stageOf({
          ...statuses,
          paymentMethod,
          deliveryMethod,
          amountPaid,
          total,
          advanceDue,
        }),
        paymentMethod,
        deliveryMethod,
        currency,
        subtotal,
        discount,
        shipping,
        codFee,
        taxRate: tax.rate,
        totalTax: tax.total,
        shippingTax: tax.charges,
        transferDiscount,
        onlineDiscount,
        total,
        amountPaid,
        codAmount: paymentMethod === 'cash_on_delivery' ? total - amountPaid - advanceDue : 0n,
        advanceDue,
        bankAccount,
        ...riskColumns(risk),
        customerId,
        repeatOfId: repeatOf?.id ?? null,
        phone: address.phone,
        email,
        shippingAddress: address,
        locationId: location.value.id,
        note: order.note,
        giftMessage: giftMessageOf(order.giftMessage),
        deliveryExpectedOn: order.deliveryExpectedOn ?? null,
        deliverySlotStartsAt: order.deliverySlot?.startsAt ?? null,
        deliverySlotEndsAt: order.deliverySlot?.endsAt ?? null,
        tags: order.tags,
        searchText: searchTextOf(address, email),
        discountCodes: order.discountCodes ?? [],
        automaticDiscounts: order.automaticDiscounts ?? [],
        confirmedAt: confirmationStatus === 'confirmed' ? sql`now()` : null,
        paidAt: amountPaid === total ? sql`now()` : null,
        ...agreementColumns(order.agreement ?? null),
        agreedAt: order.agreement ? sql`now()` : null,
        attribution: order.attribution ?? null,
        browserIds: browserIdsOf(order.browserIds),
        phoneVerifiedAt: order.phoneVerifiedAt ?? null,
      })
      .returning();
    // Lines of products on pre-order keep the day they ship by, as it is now (ADR-403).
    const preorders = await preordersIn(
      tx,
      shopId,
      priced.map((line) => line.snapshot.productId),
    );
    const stitching = await stitchingIn(
      tx,
      shopId,
      priced.map((line) => line.snapshot.productId),
    );
    await tx.insert(lines).values(
      priced.map((line, index) => ({
        shopId,
        id: newId(),
        orderId,
        position: line.position,
        variantId: line.variantId,
        productId: line.snapshot.productId,
        title: line.snapshot.productTitle,
        variantTitle: line.snapshot.variantTitle,
        sku: line.snapshot.sku,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.unitPrice * BigInt(line.quantity),
        unitCost: line.snapshot.cost,
        weightGrams: line.snapshot.weightGrams,
        taxable: line.snapshot.taxable,
        taxRate: tax.lines[index]!.rate,
        tax: tax.lines[index]!.tax,
        preorderShipsOn: preorders.get(line.snapshot.productId) ?? null,
        // Sold stitched, the days its stitching takes after it was sold or would ship (ADR-803).
        stitchedShipsOn: isStitched(line.properties ?? {})
          ? stitchedShipsOn(
              row!.createdAt,
              stitching.get(line.snapshot.productId),
              preorders.get(line.snapshot.productId) ?? null,
            )
          : null,
        bundleKey: line.bundle?.key ?? null,
        bundleTitle: line.bundle?.title ?? null,
        bundleQuantity: line.bundle?.quantity ?? null,
        properties: line.properties ?? {},
      })),
    );
    await addTimelineEntry(
      tx,
      shopId,
      orderId,
      placement.actor,
      'created',
      `Order ${orderName(number)} placed ${placement.how}: ${formatMoney(money(total, currency))}, ` +
        PAYMENT_METHOD_TEXT[paymentMethod],
    );
    if (limit && planMonth && planOrder) {
      if (planOrder.overLimit) {
        await addTimelineEntry(
          tx,
          shopId,
          orderId,
          'system',
          'over_limit',
          `Came in past the ${limit.limit} orders a month the ${limit.plan} plan allows: its ` +
            "customer is hidden from staff, and it can't be confirmed, packed, booked or shipped " +
            'until the shop chooses a bigger plan',
        );
      } else if (planOrder.warn) {
        await appendEvent<PlanOrdersCountedPayload>(tx, shopId, {
          type: OrderEvents.PlanOrdersCounted,
          aggregateType: 'shop',
          aggregateId: shopId,
          payload: {
            month: planMonth.month,
            placed: planMonth.counted + 1,
            limit: limit.limit,
            plan: limit.plan,
          },
        });
      }
    }
    if (repeatOf) {
      await addTimelineEntry(
        tx,
        shopId,
        orderId,
        'system',
        'repeat',
        `May repeat ${orderName(repeatOf.number)}, which the same number placed ` +
          `${sinceText(repeatOf.createdAt)} with items in common and is not shipped yet: ` +
          'merge it in, cancel it as a repeat, or keep both',
      );
    }
    if (blocked) {
      await addTimelineEntry(tx, shopId, orderId, 'system', 'held', heldMessage(blocked));
    } else if (risky) {
      await addTimelineEntry(tx, shopId, orderId, 'system', 'held', heldForRiskMessage(risk!));
    }
    if (askedForRisk > 0n) {
      await addTimelineEntry(
        tx,
        shopId,
        orderId,
        'system',
        'advance_asked',
        advanceForRiskMessage(risk!, formatMoney(money(askedForRisk, currency))),
      );
    }
    await shareOutIn(tx, shopId, row!);
    await appendEvent<OrderCreatedPayload>(tx, shopId, {
      type: OrderEvents.OrderCreated,
      aggregateType: 'order',
      aggregateId: orderId,
      payload: {
        number,
        customerId,
        source: row!.source,
        paymentMethod,
        total: total.toString(),
        currency,
        riskLevel: risk?.level ?? null,
        stage: row!.stage,
        version: row!.version,
      },
    });
    return { ok: true, value: (await loadOrder(tx, shopId, orderId))! };
  }

  get(tenant: TenantContext, id: string): Promise<OrderRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => loadOrder(tx, tenant.shopId, id));
  }

  /** An order of the shop's, in the caller's transaction `tx`: for checkout's thank-you page. */
  orderOf(tx: Tx, shopId: string, id: string): Promise<OrderRecord | null> {
    return loadOrder(tx, shopId, id);
  }

  /** Orders by ID, for a request's loader; those not found are left out. */
  async getMany(tenant: TenantContext, ids: readonly string[]): Promise<Map<string, OrderRecord>> {
    if (ids.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await loadOrders(tx, tenant.shopId, {
        where: sql`o.id = ANY(${sql.param([...ids])}::uuid[])`,
        prepared: true,
      });
      return new Map(found.map((order) => [order.id, order]));
    });
  }

  /**
   * Where orders' customers came to the online store from before placing them (ADR-139), by
   * order ID, for a request's loader; orders placed otherwise are left out.
   */
  async attributionsOf(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, OrderAttributionRecord>> {
    if (ids.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ id: orders.id, createdAt: orders.createdAt, attribution: orders.attribution })
        .from(orders)
        .where(
          and(
            eq(orders.shopId, tenant.shopId),
            inArray(orders.id, [...ids]),
            isNotNull(orders.attribution),
          ),
        );
      return new Map(
        rows.map((row) => [row.id, toAttributionRecord(row.id, row.attribution!, row.createdAt)]),
      );
    });
  }

  /**
   * Orders, newest first. A page of the shop's newest orders, or of one stage's, customer's or
   * risk level's, is prepared (ADR-111): each has an index in that order, whatever the shop.
   * Searches, dates and filters together are planned each time.
   */
  async list(tenant: TenantContext, options: ListOrdersOptions): Promise<Page<OrderRecord>> {
    const conditions = orderConditions({ ...options, me: staffMemberOf(tenant) });
    const prepared =
      !options.query?.trim() &&
      !options.placedFrom &&
      !options.placedBefore &&
      (options.transferReceipt === undefined || options.transferReceipt === null) &&
      [options.stage, options.riskLevel, options.customerId].filter(Boolean).length <= 1;
    if (options.after) conditions.push(sql`o.id < ${options.after}`);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await loadOrders(tx, tenant.shopId, {
        where: conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined,
        order: sql`o.id DESC`,
        limit: options.first + 1,
        prepared,
      });
      return { items: rows.slice(0, options.first), hasNextPage: rows.length > options.first };
    });
  }

  /**
   * The customer's number on an order in full, for staff who see it masked; null once the
   * customer's details are erased. The audit log records that it was revealed, and to whom.
   */
  async revealPhone(tenant: TenantContext, id: string): Promise<MutationResult<string | null>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [order] = await tx
        .select({ number: orders.number, phone: orders.phone, overLimitAt: orders.overLimitAt })
        .from(orders)
        .where(and(eq(orders.shopId, tenant.shopId), eq(orders.id, id)));
      if (!order) return failOne(['id'], 'NOT_FOUND', 'Order not found');
      if (order.overLimitAt) return failOne(['id'], 'INVALID', OVER_LIMIT_MESSAGE);
      if (order.phone !== null) {
        await recordAudit(tx, tenant.shopId, {
          action: 'order.phone_revealed',
          subjectType: 'order',
          subjectId: id,
          ...actorColumnsOf(tenant.actor),
          details: { number: order.number },
        });
      }
      return { ok: true, value: order.phone };
    });
  }

  /**
   * Frees every order of the shop past its plan's limit (ADR-263), as a plan with room for them
   * begins: how many there were.
   */
  async releaseOverLimit(shopId: string): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      const released = await tx
        .update(orders)
        .set({ overLimitAt: null, version: sql`${orders.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(orders.shopId, shopId), isNotNull(orders.overLimitAt)))
        .returning({ id: orders.id });
      for (const { id } of released) {
        await addTimelineEntry(
          tx,
          shopId,
          id,
          'system',
          'over_limit_released',
          "The shop's plan has room for it now: its customer shows, and it can be worked on",
        );
      }
      return released.length;
    });
  }

  /**
   * How many orders are at each stage, for the tabs of the order list; with `locationId`, of
   * those shipping from there (ADR-356).
   */
  async stageCounts(
    tenant: TenantContext,
    options: { locationId?: string | null } = {},
  ): Promise<Map<OrderStageValue, number>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ stage: OrderStageValue; count: number }>(sql`
        SELECT stage, count(*)::int AS count FROM orders.orders
         WHERE shop_id = ${tenant.shopId}
           ${options.locationId ? sql`AND location_id = ${options.locationId}` : sql``}
         GROUP BY stage`);
      const counts = new Map<OrderStageValue, number>(ORDER_STAGES.map((stage) => [stage, 0]));
      for (const row of rows) counts.set(row.stage, row.count);
      return counts;
    });
  }

  /**
   * What waits for the shop, for the admin's home (ANL-01): orders at the stages that need
   * something of staff, and the cash on delivery still to come, in one statement over the stage
   * index; the parcels the courier lost, to claim and claimed (ADR-093), over the index of
   * those; and the customer returns on their way (ADR-138), over theirs.
   */
  async home(
    tenant: TenantContext,
    options: { locationId?: string | null } = {},
  ): Promise<OrderHome> {
    // With a location, what waits there alone (ADR-358): its orders, their parcels and returns.
    const at = (column: SQL) =>
      options.locationId ? sql`AND ${column} = ${options.locationId}` : sql``;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        stage: OrderStageValue;
        count: number;
        total: string;
        unpaid_count: number;
        unpaid: string;
        receipted_count: number;
        receipted: string;
      }>(sql`
        SELECT stage, count(*)::int AS count, coalesce(sum(total), 0)::text AS total,
               count(*) FILTER (WHERE payment_method = 'cash_on_delivery'
                                  AND amount_paid < total)::int AS unpaid_count,
               coalesce(sum(total - amount_paid) FILTER (
                 WHERE payment_method = 'cash_on_delivery' AND amount_paid < total), 0)::text
                 AS unpaid,
               count(*) FILTER (WHERE receipted)::int AS receipted_count,
               coalesce(sum(total) FILTER (WHERE receipted), 0)::text AS receipted
          FROM (SELECT o.*,
                       o.stage = 'awaiting_payment' AND EXISTS (
                         SELECT 1 FROM orders.transfer_receipts r
                          WHERE r.shop_id = o.shop_id AND r.order_id = o.id) AS receipted
                  FROM orders.orders o) o
         WHERE shop_id = ${tenant.shopId} ${at(sql`location_id`)}
           AND stage IN ('needs_confirmation', 'needs_review', 'awaiting_payment', 'to_pack',
                         'to_book', 'ready_for_pickup', 'partially_fulfilled', 'in_transit',
                         'returning', 'delivered')
         GROUP BY stage`);
      // Parcels the courier lost that are not claimed yet, at their worth; and the claims still
      // open, for those and for parcels that came back damaged (ADR-098).
      const { rows: lost } = await tx.execute<{
        unclaimed_count: number;
        unclaimed: string;
        open_count: number;
        open: string;
      }>(sql`
        SELECT count(*) FILTER (WHERE status = 'lost' AND claim_status IS NULL)::int
                 AS unclaimed_count,
               coalesce(sum(worth) FILTER (WHERE status = 'lost' AND claim_status IS NULL), 0)::text
                 AS unclaimed,
               count(*) FILTER (WHERE claim_status = 'open')::int AS open_count,
               coalesce(sum(claim_amount) FILTER (WHERE claim_status = 'open'), 0)::text AS open
          FROM (SELECT f.status, f.claim_status, f.claim_amount,
                       CASE WHEN f.claim_status IS NULL THEN ${parcelWorth(sql`f`)} END AS worth
                  FROM orders.fulfillments f
                 WHERE f.shop_id = ${tenant.shopId} ${at(sql`f.location_id`)}
                   AND (f.status = 'lost' OR f.claim_status IS NOT NULL)) f`);
      const { rows: coming } = await tx.execute<{ count: number; total: string }>(sql`
        SELECT count(*)::int AS count,
               coalesce(sum((SELECT sum(rl.quantity * l.unit_price)
                               FROM orders.return_lines rl
                               JOIN orders.lines l ON l.shop_id = rl.shop_id AND l.id = rl.line_id
                              WHERE rl.shop_id = rt.shop_id AND rl.return_id = rt.id)), 0)::text
                 AS total
          FROM orders.returns rt
         WHERE rt.shop_id = ${tenant.shopId} ${at(sql`rt.location_id`)} AND rt.status = 'open'`);
      const stageAt = (stage: OrderStageValue): OrderTally => {
        const row = rows.find((each) => each.stage === stage);
        return { count: row?.count ?? 0, total: BigInt(row?.total ?? 0) };
      };
      // Cash still to come: on its way, or delivered and not yet paid for.
      const owing = rows.filter((row) =>
        ['partially_fulfilled', 'in_transit', 'delivered'].includes(row.stage),
      );
      return {
        toConfirm: stageAt('needs_confirmation'),
        toReview: stageAt('needs_review'),
        awaitingPayment: stageAt('awaiting_payment'),
        transfersToCheck: {
          count: rows.reduce((sum, row) => sum + row.receipted_count, 0),
          total: rows.reduce((sum, row) => sum + BigInt(row.receipted), 0n),
        },
        toPack: stageAt('to_pack'),
        toBook: stageAt('to_book'),
        readyForPickup: stageAt('ready_for_pickup'),
        returning: stageAt('returning'),
        returnsToReceive: { count: coming[0]!.count, total: BigInt(coming[0]!.total) },
        lostToClaim: { count: lost[0]!.unclaimed_count, total: BigInt(lost[0]!.unclaimed) },
        claimsOpen: { count: lost[0]!.open_count, total: BigInt(lost[0]!.open) },
        cashToCollect: {
          count: owing.reduce((sum, row) => sum + row.unpaid_count, 0),
          total: owing.reduce((sum, row) => sum + BigInt(row.unpaid), 0n),
        },
      };
    });
  }

  /** What each customer's orders add up to. Customers without orders are left out. */
  async customerStats(
    tenant: TenantContext,
    customerIds: readonly string[],
  ): Promise<Map<string, CustomerOrderStats>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        customer_id: string;
        number_of_orders: number;
        amount_spent: string;
        delivered_orders: number;
        returned_orders: number;
        lost_orders: number;
        cancelled_orders: number;
        last_order_at: string;
      }>(customerFactsQuery(tenant.shopId, customerIds));
      return new Map(
        rows.map((row) => [
          row.customer_id,
          {
            count: row.number_of_orders,
            amountSpent: BigInt(row.amount_spent),
            delivered: row.delivered_orders,
            returned: row.returned_orders,
            lost: row.lost_orders,
            cancelled: row.cancelled_orders,
            inProgress:
              row.number_of_orders -
              row.delivered_orders -
              row.returned_orders -
              row.lost_orders -
              row.cancelled_orders,
            lastOrderAt: toDateOrNull(row.last_order_at),
          },
        ]),
      );
    });
  }

  /**
   * How many orders the customer with `phone` refused at the door or could not be delivered to
   * (`returned`), and how many the shop delivered to them, as their delivery history counts them,
   * by any of their numbers, in the caller's transaction: none for a number no customer has. For
   * checkout's rules on cash on delivery and their advance (CHK-07, ADR-089, ADR-094).
   */
  async deliveriesOf(
    tx: Tx,
    shopId: string,
    phone: string,
  ): Promise<{ refused: number; delivered: number }> {
    const customerId = await this.customers.idOf(tx, shopId, phone);
    if (!customerId) return { refused: 0, delivered: 0 };
    const { rows } = await tx.execute<{ returned_orders: number; delivered_orders: number }>(
      customerFactsQuery(shopId, [customerId]),
    );
    return { refused: rows[0]?.returned_orders ?? 0, delivered: rows[0]?.delivered_orders ?? 0 };
  }

  /**
   * How many orders checkout placed lately from where a new one comes from (CHK-18, ADR-087): to
   * its mobile number `phone` in the last day, and from its internet address `ip` in the last
   * hour, cancelled ones too; none from an address not known, or not an address, as orders keep
   * none then. Orders that came another way keep addresses too, such as drafts their customers
   * confirmed through their links (ADR-114), and are not counted. In the caller's transaction,
   * which holds a lock on the number, then on the address, until it ends, so that orders from
   * either are counted and placed one at a time.
   */
  async checkoutOrdersFrom(
    tx: Tx,
    shopId: string,
    from: { phone: string; ip: string | null },
  ): Promise<{ phoneDay: number; ipHour: number }> {
    const ip = from.ip && isIP(from.ip) !== 0 ? from.ip : null;
    const lock = (subject: string) =>
      tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${shopId}:${subject}`}, 0))`,
      );
    await lock(`phone:${from.phone}`);
    if (ip) await lock(`ip:${ip}`);
    const { rows } = await tx.execute<{ phone_day: number; ip_hour: number }>(sql`
      SELECT (SELECT count(*)::int
                FROM orders.orders
               WHERE shop_id = ${shopId} AND phone = ${from.phone} AND source = 'online_store'
                 AND created_at > now() - interval '1 day') AS phone_day,
             (SELECT count(*)::int
                FROM orders.orders
               WHERE shop_id = ${shopId} AND client_ip = ${ip}::inet
                 AND source = 'online_store' AND created_at > now() - interval '1 hour') AS ip_hour`);
    return { phoneDay: rows[0]!.phone_day, ipHour: rows[0]!.ip_hour };
  }

  /**
   * How many units of each of `productIds` orders to mobile number `phone` took since `since`,
   * cancelled ones aside, as a drop's limit for each customer counts them (ADR-820); products of
   * none are left out. In the caller's transaction, which holds the number's lock as
   * {@link checkoutOrdersFrom} takes it, so that its orders are counted one at a time.
   */
  async unitsOrderedByIn(
    tx: Tx,
    shopId: string,
    phone: string,
    productIds: readonly string[],
    since: Date,
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const { rows } = await tx.execute<{ product_id: string; units: number }>(sql`
      SELECT l.product_id, sum(l.quantity)::int AS units
        FROM orders.orders o
        JOIN orders.lines l ON l.shop_id = o.shop_id AND l.order_id = o.id
       WHERE o.shop_id = ${shopId} AND o.phone = ${phone} AND o.status <> 'cancelled'
         AND o.created_at >= ${since.toISOString()}
         AND l.product_id = ANY(${sql.param([...productIds])}::uuid[])
       GROUP BY l.product_id`);
    return new Map(rows.map((row) => [row.product_id, row.units]));
  }

  /**
   * How many orders, cancelled ones aside, are to be delivered in the slots starting at
   * `startsAt` (CHK-15, ADR-772), by when each starts, in ms; slots with none are left out. In
   * the caller's transaction `tx`; with `lock`, which holds a lock on the shop's slots until it
   * ends, so that orders for a slot are counted and placed one at a time.
   */
  async deliverySlotsTakenIn(
    tx: Tx,
    shopId: string,
    startsAt: readonly Date[],
    options: { lock?: boolean } = {},
  ): Promise<Map<number, number>> {
    if (options.lock) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${shopId}:slots`}, 0))`,
      );
    }
    if (startsAt.length === 0) return new Map();
    const { rows } = await tx.execute<{ starts_at: string; taken: number }>(sql`
      SELECT delivery_slot_starts_at AS starts_at, count(*)::int AS taken
        FROM orders.orders
       WHERE shop_id = ${shopId} AND cancelled_at IS NULL
         AND delivery_slot_starts_at = ANY(${sql.param(startsAt.map((at) => at.toISOString()))}::timestamptz[])
       GROUP BY delivery_slot_starts_at`);
    return new Map(rows.map((row) => [new Date(row.starts_at).getTime(), row.taken]));
  }

  /**
   * The latest order the number placed in the shop since `since`, by any way, in the caller's
   * transaction `tx`: for checkout not to remind a shopper who ordered meanwhile (ADR-393).
   */
  async latestOrderFromIn(
    tx: Tx,
    shopId: string,
    phone: string,
    since: Date,
  ): Promise<{ id: string; number: number } | null> {
    const { rows } = await tx.execute<{ id: string; number: number }>(sql`
      SELECT id, number FROM orders.orders
       WHERE shop_id = ${shopId} AND phone = ${phone} AND created_at >= ${since.toISOString()}::timestamptz
       ORDER BY created_at DESC
       LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * The different addresses each customer's orders went to, most recently used first: at most
   * `limit` per customer.
   */
  async customerAddresses(
    tenant: TenantContext,
    customerIds: readonly string[],
    limit: number,
  ): Promise<Map<string, AddressValue[]>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ customer_id: string; shipping_address: AddressValue }>(
        sql`
        SELECT customer_id, shipping_address
          FROM (SELECT customer_id, shipping_address, max(created_at) AS latest,
                       row_number() OVER (PARTITION BY customer_id
                                          ORDER BY max(created_at) DESC) AS rank
                  FROM orders.orders
                 WHERE shop_id = ${tenant.shopId}
                   AND customer_id = ANY(${sql.param([...customerIds])}::uuid[])
                 GROUP BY customer_id, shipping_address) used
         WHERE rank <= ${limit}
         ORDER BY customer_id, latest DESC`,
      );
      const addresses = new Map<string, AddressValue[]>();
      for (const row of rows) {
        const list = addresses.get(row.customer_id) ?? [];
        list.push(row.shipping_address);
        addresses.set(row.customer_id, list);
      }
      return addresses;
    });
  }

  /** The order's timeline, newest first. */
  /**
   * An order's timeline, newest first. Prepared (ADR-122): every order's page reads it, one
   * statement for each page size, with a cursor or without.
   */
  async timeline(
    tenant: TenantContext,
    orderId: string,
    options: { first: number; after?: string | null },
  ): Promise<Page<OrderEventRecord>> {
    const after = options.after ? sql`AND id < ${options.after}` : sql``;
    return this.db.tenant(tenant.shopId, async (tx) => {
      // Events and comments by their IDs, which both take in the order they were made: each
      // branch reads its index backwards, and Postgres merges them (ADR-128).
      const { rows } = await executePrepared<TimelineRow>(
        tx,
        sql`
        SELECT id, order_id, kind, message, actor_kind, actor_id, created_at, comment, edited_at
          FROM (SELECT id, order_id, kind, message, actor_kind, actor_id, created_at,
                       false AS comment, NULL::timestamptz AS edited_at
                  FROM ${orderEvents}
                 WHERE shop_id = ${tenant.shopId} AND order_id = ${orderId} ${after}
                UNION ALL
                SELECT id, order_id, 'comment', message, author_kind, author_id, created_at,
                       true, edited_at
                  FROM ${orderComments}
                 WHERE shop_id = ${tenant.shopId} AND order_id = ${orderId} ${after}) AS entries
         ORDER BY id DESC
         ${literalLimit(options.first + 1)}`,
      );
      return {
        items: rows.slice(0, options.first).map(toTimelineEntry),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** Changes the shipping address, email, note or tags. */
  async update(
    tenant: TenantContext,
    id: string,
    input: OrderUpdateInput,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const address =
      input.shippingAddress === undefined || input.shippingAddress === null
        ? undefined
        : checkAddress(check, ['input', 'shippingAddress'], input.shippingAddress);
    if (input.shippingAddress === null) {
      check.add(['input', 'shippingAddress'], 'BLANK', "can't be blank");
    }
    const email =
      input.email === undefined ? undefined : check.email(['input', 'email'], input.email);
    const note =
      input.note === undefined
        ? undefined
        : (check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '');
    const tags = input.tags === undefined ? undefined : check.tags(['input', 'tags'], input.tags);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(
      tenant,
      id,
      ['id'],
      (tx, order) =>
        this.updateLocked(
          tx,
          tenant.shopId,
          order,
          { address: address ?? undefined, email, note, tags },
          { actor: tenant.actor },
        ),
      { overLimit: 'allow' },
    );
  }

  /**
   * Changes an order locked in the caller's transaction, as {@link update} does, to values checked
   * already, with who did it for its timeline: the caller, or the customer through their link.
   * `message` words the timeline entry from what changed, "shipping address, note"; "Changed the
   * …" unless given. Errors name fields of orderUpdate's input.
   */
  async updateLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    values: CheckedOrderUpdate,
    by: { actor: Actor | 'system'; message?: (changed: string) => string },
  ): Promise<MutationResult<OrderRow>> {
    const { address, email, note, tags } = values;
    if (order.customerErasedAt && (email !== undefined || address)) {
      return failOne(
        ['input', email !== undefined ? 'email' : 'shippingAddress'],
        'INVALID',
        "The customer's details on this order were erased at their request",
      );
    }
    const changes: Partial<OrderRow> = {};
    const changed: string[] = [];
    let moved: AddressValue | null = null;
    if (address && !sameAddress(address, order.shippingAddress)) {
      if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(
          ['input', 'shippingAddress'],
          'INVALID',
          'The address can only change while nothing has shipped',
        );
      }
      moved = address;
      changes.shippingAddress = address;
      changes.phone = address.phone;
      changed.push('shippingAddress');
    }
    if (email !== undefined && email !== order.email) {
      changes.email = email;
      changed.push('email');
    }
    if (note !== undefined && note !== order.note) {
      changes.note = note;
      changed.push('note');
    }
    if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(order.tags)) {
      changes.tags = tags;
      changed.push('tags');
    }
    if (changed.length === 0) return { ok: true, value: order };
    if (changes.shippingAddress || changes.email !== undefined) {
      changes.searchText = searchTextOf(
        changes.shippingAddress ?? order.shippingAddress,
        changes.email !== undefined ? changes.email : order.email,
      );
    }
    // A new number makes it the order of that number's customer, and may be a blocked one.
    let held: BlocklistEntryRecord | null = null;
    let heldForRisk: RiskAssessment | null = null;
    if (moved && moved.phone !== order.phone) {
      const customerId = await this.customers.findOrCreate(tx, shopId, {
        phone: moved.phone,
        name: moved.name,
        email: changes.email !== undefined ? changes.email : order.email,
      });
      if (customerId !== order.customerId) {
        changes.customerId = customerId;
        changed.push('customer');
      }
      const entry = await this.blocklist.entryOf(tx, shopId, moved.phone);
      if (entry && order.confirmationStatus !== 'needs_review') {
        changes.confirmationStatus = 'needs_review';
        held = entry;
      }
    }
    // A cash-on-delivery order is scored again for its new address. It waits for review if the
    // change is what makes it risky: staff who reviewed a risky order can still correct it.
    if (moved && order.paymentMethod === 'cash_on_delivery') {
      const { assessment, settings } = await assessOrderRisk(tx, shopId, {
        orderId: order.id,
        splitFromId: order.splitFromId,
        customerId: changes.customerId ?? order.customerId,
        total: order.total,
        currency: order.currency as CurrencyCode,
        units: (await parcelSummary(tx, shopId, order.id)).units,
        address: moved,
      });
      Object.assign(changes, riskColumns(assessment));
      const wasRisky = order.riskScore !== null && holdsForRisk(settings, order.riskScore);
      if (
        !wasRisky &&
        holdsForRisk(settings, assessment.score) &&
        order.confirmationStatus !== 'needs_review' &&
        !held
      ) {
        changes.confirmationStatus = 'needs_review';
        heldForRisk = assessment;
      }
    }
    const updated = await updateOrder(tx, shopId, order, changes);
    const names = changed.map((name) => CHANGE_NAMES[name] ?? name).join(', ');
    await addTimelineEntry(
      tx,
      shopId,
      order.id,
      by.actor,
      'updated',
      by.message ? by.message(names) : `Changed the ${names}`,
    );
    if (held) {
      await addTimelineEntry(tx, shopId, order.id, 'system', 'held', heldMessage(held));
    } else if (heldForRisk) {
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        'system',
        'held',
        heldForRiskMessage(heldForRisk),
      );
    }
    await appendEvent<OrderUpdatedPayload>(tx, shopId, {
      type: OrderEvents.OrderUpdated,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { changed, stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
  }

  /**
   * Keeps an order apart from the order it may repeat (CHK-11, ADR-392): it is not a repeat, as
   * when the customer wanted both. Keeping one that repeats nothing changes nothing.
   */
  async keepRepeat(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(
      tenant,
      id,
      ['id'],
      async (tx, order) => {
        if (!order.repeatOfId) return { ok: true, value: order };
        const [earlier] = await tx
          .select({ number: orders.number })
          .from(orders)
          .where(and(eq(orders.shopId, tenant.shopId), eq(orders.id, order.repeatOfId)));
        const updated = await updateOrder(tx, tenant.shopId, order, { repeatOfId: null });
        await addTimelineEntry(
          tx,
          tenant.shopId,
          order.id,
          tenant.actor,
          'repeat_kept',
          earlier
            ? `Kept apart from ${orderName(earlier.number)}: not a repeat`
            : 'Kept: not a repeat',
        );
        await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['repeat'], stage: updated.stage, version: updated.version },
        });
        return { ok: true, value: updated };
      },
      { overLimit: 'allow' },
    );
  }

  /**
   * Records that the customer confirmed a cash-on-delivery order, or that staff reviewed an order
   * held for review and let it go ahead.
   */
  async confirm(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], (tx, order) =>
      this.confirmLocked(tx, tenant.shopId, order, {
        actor: tenant.actor,
        message:
          order.confirmationStatus === 'needs_review'
            ? 'Reviewed and confirmed'
            : 'Confirmed by the customer',
      }),
    );
  }

  /**
   * Confirms an order locked in the caller's transaction, as {@link confirm} does, with who did
   * it and how for its timeline. Confirming a confirmed order changes nothing.
   */
  async confirmLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    by: {
      actor: Actor | 'system';
      message: string;
      /** What its customer agreed to in confirming it themselves, through its link (ADR-115). */
      agreement?: OrderAgreementInput;
    },
  ): Promise<MutationResult<OrderRow>> {
    if (order.status === 'cancelled') {
      return failOne(['id'], 'INVALID', "A cancelled order can't be confirmed");
    }
    if (order.confirmationStatus === 'confirmed' || order.confirmationStatus === 'not_required') {
      return { ok: true, value: order };
    }
    // Kept unless the order keeps what they agreed to in placing it.
    const agreement = order.agreedPolicyVersions ? null : (by.agreement ?? null);
    const updated = await updateOrder(
      tx,
      shopId,
      order,
      { confirmationStatus: 'confirmed', ...(agreement ? agreementColumns(agreement) : {}) },
      agreement ? ['confirmedAt', 'agreedAt'] : ['confirmedAt'],
    );
    await addTimelineEntry(tx, shopId, order.id, by.actor, 'confirmed', by.message);
    await appendEvent<OrderConfirmedPayload>(tx, shopId, {
      type: OrderEvents.OrderConfirmed,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
  }

  /**
   * Cancels an order that has not shipped, and releases its committed stock. Money already paid
   * is refunded outside Hatti for now.
   */
  async cancel(
    tenant: TenantContext,
    id: string,
    options: CancelOptions,
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const staffNote = check.text(['staffNote'], options.staffNote, { max: LIMITS.note });
    if (options.reason === 'merged') {
      check.addMessage(['reason'], 'INVALID', MERGED_ONLY_BY_MERGING);
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.#change(
      tenant,
      id,
      ['id'],
      (tx, order) =>
        this.cancelLocked(tx, tenant.shopId, order, {
          actor: tenant.actor,
          reason: options.reason,
          message:
            `Cancelled because ${CANCEL_REASON_TEXT[options.reason]}` +
            (staffNote ? `: ${staffNote}` : ''),
        }),
      { overLimit: 'allow' },
    );
  }

  /**
   * Cancels an order locked in the caller's transaction, as {@link cancel} does, with who did it
   * and how for its timeline. `declined` records that the customer turned it down when asked to
   * confirm it. Cancelling a cancelled order changes nothing.
   */
  async cancelLocked(
    tx: Tx,
    shopId: string,
    order: OrderRow,
    by: {
      actor: Actor | 'system';
      reason: CancelReasonValue;
      message: string;
      declined?: boolean;
    },
  ): Promise<MutationResult<OrderRow>> {
    if (order.status === 'cancelled') return { ok: true, value: order };
    if (order.status === 'closed' || order.fulfillmentStatus !== 'unfulfilled') {
      return failOne(['id'], 'INVALID', "An order that has shipped can't be cancelled");
    }
    const orderLines = await tx
      .select({ variantId: lines.variantId, quantity: lines.quantity })
      .from(lines)
      .where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
    const released = await this.stock.releaseCommitment(
      tx,
      { shopId, actor: by.actor },
      orderLines.map((line) => ({ ...line, locationId: order.locationId })),
      { referenceDocumentUri: orderReference(order.id) },
    );
    if (!released.ok) throw new Error('Releasing stock cannot fall short');

    // Store credit that paid it goes back to its customer, the payment void (ADR-185); where
    // refunds took more of what was paid than the rest left, as much as they left (ADR-663).
    const credit = await storeCreditPaidIn(tx, shopId, order.id);
    const left = order.amountPaid - order.amountRefunded;
    const creditGiven = await giveCreditBackIn(tx, shopId, by.actor, order.id, credit, left);
    // Gift cards that paid it get it back likewise (ADR-449, ADR-664), from what is left after.
    const cards = await giftCardsPaidIn(tx, shopId, order.id);
    const cardsLeft = left - creditGiven;
    const cardsGiven = await giveCardsBackIn(tx, shopId, by.actor, order.id, cards, cardsLeft);
    const voided = creditGiven > 0n || cardsGiven > 0n;
    const paid = order.amountPaid - creditGiven - cardsGiven;
    const updated = await updateOrder(
      tx,
      shopId,
      order,
      {
        status: 'cancelled',
        cancelReason: by.reason,
        ...(by.declined ? { confirmationStatus: 'rejected' as const } : {}),
        ...(voided ? { amountPaid: paid, financialStatus: voidedStatusOf(paid, order) } : {}),
      },
      ['cancelledAt'],
    );
    await addTimelineEntry(tx, shopId, order.id, by.actor, 'cancelled', by.message);
    if (credit > 0n) {
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        by.actor,
        'refunded',
        creditBackText(order, credit, creditGiven, left),
      );
    }
    if (cards > 0n) {
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        by.actor,
        'refunded',
        cardsBackText(order, cards, cardsGiven, cardsLeft),
      );
    }
    // Credit given for paying it online goes with it, but what was spent of it (ADR-432).
    if (order.prepayCreditedAt) {
      const name = orderName(order.number);
      const taken = await withdrawOrderCreditIn(
        tx,
        shopId,
        by.actor,
        order.id,
        `${name} cancelled, after paying it online`,
      );
      if (taken > 0n) {
        await addTimelineEntry(
          tx,
          shopId,
          order.id,
          by.actor,
          'prepay_withdrawn',
          `Took back ${formatMoney(money(taken, order.currency as CurrencyCode))} of the store ` +
            'credit given for paying it online',
        );
      }
    }
    await appendEvent<OrderCancelledPayload>(tx, shopId, {
      type: OrderEvents.OrderCancelled,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { reason: by.reason, stage: updated.stage, version: updated.version },
    });
    return { ok: true, value: updated };
  }

  /**
   * Cancels the shop's orders whose customers could not be reached (`no_response`, three calls
   * unanswered) and that still wait `days` days after they were placed (COD-05, ADR-092), the
   * oldest first and {@link UNREACHABLE_LIMITS.batch} at most: each in a transaction of its own,
   * by the system, its stock let go. An order answered or settled since it was found is left as
   * it is. How many it cancelled.
   */
  async cancelUnreachable(shopId: string, days: number, at: Date = new Date()): Promise<number> {
    const unreachable = and(
      eq(orders.shopId, shopId),
      eq(orders.status, 'open'),
      eq(orders.stage, 'needs_confirmation'),
      eq(orders.confirmationStatus, 'no_response'),
      lt(orders.createdAt, new Date(at.getTime() - days * 86_400_000)),
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(unreachable)
        .orderBy(asc(orders.createdAt))
        .limit(UNREACHABLE_LIMITS.batch),
    );
    let cancelled = 0;
    for (const { id } of found) {
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(unreachable, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        const result = await this.cancelLocked(tx, shopId, order, {
          actor: 'system',
          reason: 'no_response',
          message: `Cancelled: the customer could not be reached in ${days} ${days === 1 ? 'day' : 'days'}`,
        });
        return result.ok;
      });
      if (done) cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Asks the shop's customers once more to confirm their cash-on-delivery orders (COD-01,
   * ADR-175): those still waiting for their answer {@link CONFIRMATION_REMINDER.afterMs} after
   * they were placed, and placed within {@link CONFIRMATION_REMINDER.withinMs}, the oldest first
   * and {@link CONFIRMATION_REMINDER.batch} at most; only in the shop's calling hours, or 9:00 to
   * 21:00 in its time zone without them. An event asks the worker to send it. How many it asked.
   */
  async remindToConfirm(shopId: string, at: Date = new Date()): Promise<number> {
    const awake = await this.db.tenant(shopId, async (tx) => {
      const { callingHours } = await orderSettingsIn(tx, shopId);
      const { timezone } = await shopProfile(tx, shopId);
      const hours = callingHours ?? CONFIRMATION_REMINDER.hours;
      const windows = await callingWindowsIn(tx, hours, timezone, at, { back: 1, ahead: 0 });
      return isCallingTime(windows, at);
    });
    if (!awake) return 0;
    const due = and(
      eq(orders.shopId, shopId),
      eq(orders.status, 'open'),
      eq(orders.stage, 'needs_confirmation'),
      eq(orders.paymentMethod, 'cash_on_delivery'),
      eq(orders.fulfillmentStatus, 'unfulfilled'),
      inArray(orders.confirmationStatus, ['pending', 'no_response']),
      isNull(orders.confirmationRemindedAt),
      lt(orders.createdAt, new Date(at.getTime() - CONFIRMATION_REMINDER.afterMs)),
      gte(orders.createdAt, new Date(at.getTime() - CONFIRMATION_REMINDER.withinMs)),
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(due)
        .orderBy(asc(orders.createdAt))
        .limit(CONFIRMATION_REMINDER.batch),
    );
    let reminded = 0;
    for (const { id } of found) {
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(due, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        await tx
          .update(orders)
          .set({ confirmationRemindedAt: at })
          .where(and(eq(orders.shopId, shopId), eq(orders.id, id)));
        await appendEvent<OrderConfirmationRemindedPayload>(tx, shopId, {
          type: OrderEvents.OrderConfirmationReminded,
          aggregateType: 'order',
          aggregateId: id,
          payload: { stage: order.stage, version: order.version },
        });
        return true;
      });
      if (done) reminded += 1;
    }
    return reminded;
  }

  /**
   * Calls the customers of the shop's cash-on-delivery orders still waiting for their answer
   * {@link CONFIRMATION_CALL.afterReminderMs} after they were asked again to confirm them (COD-03,
   * ADR-611), where the shop's order settings say to: all of them, or those of high value by its
   * risk settings. Once each, the oldest first and {@link CONFIRMATION_CALL.batch} at most; only
   * in the shop's calling hours, as reminders go, and not for orders placed longer ago than
   * reminders are sent. An event asks the worker to place the call. How many it called.
   */
  async callToConfirm(shopId: string, at: Date = new Date()): Promise<number> {
    const calls = await this.db.tenant(shopId, async (tx) => {
      const { callingHours, confirmationCalls } = await orderSettingsIn(tx, shopId);
      if (confirmationCalls === 'off') return null;
      const { timezone } = await shopProfile(tx, shopId);
      const hours = callingHours ?? CONFIRMATION_REMINDER.hours;
      const windows = await callingWindowsIn(tx, hours, timezone, at, { back: 1, ahead: 0 });
      return isCallingTime(windows, at) ? confirmationCalls : null;
    });
    if (!calls) return 0;
    const due = and(
      eq(orders.shopId, shopId),
      eq(orders.status, 'open'),
      eq(orders.stage, 'needs_confirmation'),
      eq(orders.paymentMethod, 'cash_on_delivery'),
      eq(orders.fulfillmentStatus, 'unfulfilled'),
      inArray(orders.confirmationStatus, ['pending', 'no_response']),
      isNull(orders.confirmationCalledAt),
      lt(orders.confirmationRemindedAt, new Date(at.getTime() - CONFIRMATION_CALL.afterReminderMs)),
      gte(orders.createdAt, new Date(at.getTime() - CONFIRMATION_REMINDER.withinMs)),
      calls === 'high_value'
        ? sql`${orders.riskReasons} @> '[{"code": "high_value"}]'::jsonb`
        : undefined,
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(due)
        .orderBy(asc(orders.createdAt))
        .limit(CONFIRMATION_CALL.batch),
    );
    let called = 0;
    for (const { id } of found) {
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(due, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        await tx
          .update(orders)
          .set({ confirmationCalledAt: at })
          .where(and(eq(orders.shopId, shopId), eq(orders.id, id)));
        await addTimelineEntry(
          tx,
          shopId,
          id,
          'system',
          'confirmation_call',
          'Calling the customer to confirm it, by an automated call in Urdu',
        );
        await appendEvent<OrderConfirmationCalledPayload>(tx, shopId, {
          type: OrderEvents.OrderConfirmationCalled,
          aggregateType: 'order',
          aggregateId: id,
          payload: { stage: order.stage, version: order.version },
        });
        return true;
      });
      if (done) called += 1;
    }
    return called;
  }

  /**
   * Reminds the customers of the shop's orders still waiting for their payment, which
   * {@link cancelUnpaid} cancels `after` they were placed (ADR-174): once, a day before then and
   * no sooner than half a day after the order was placed, or halfway through a wait of a day or
   * less (ADR-657), the oldest first and
   * {@link UNPAID_LIMITS.batch} at most. An event says when each is cancelled, for the worker to
   * tell its customer. One with a receipt waiting to be checked, or with a payment `underway`, is
   * left as it is. How many it reminded.
   */
  async remindUnpaid(
    shopId: string,
    wait: UnpaidWait,
    at: Date = new Date(),
    underway: (orderIds: string[]) => Promise<ReadonlySet<string>> = async () => new Set(),
  ): Promise<number> {
    const window = unpaidWait(wait).ms;
    const after = Math.max(
      window - UNPAID_LIMITS.reminderBeforeMs,
      Math.min(UNPAID_LIMITS.reminderAfterMs, window / 2),
    );
    const due = and(
      waitingForPayment(shopId),
      isNull(orders.paymentRemindedAt),
      lt(orders.createdAt, new Date(at.getTime() - after)),
      // Those due to be cancelled are cancelled, not reminded.
      gte(orders.createdAt, new Date(at.getTime() - window)),
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(due)
        .orderBy(asc(orders.createdAt))
        .limit(UNPAID_LIMITS.batch),
    );
    if (found.length === 0) return 0;
    const paying = await underway(found.map((order) => order.id));
    let reminded = 0;
    for (const { id } of found) {
      if (paying.has(id)) continue;
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(due, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        await tx
          .update(orders)
          .set({ paymentRemindedAt: at })
          .where(and(eq(orders.shopId, shopId), eq(orders.id, id)));
        await appendEvent<OrderPaymentRemindedPayload>(tx, shopId, {
          type: OrderEvents.OrderPaymentReminded,
          aggregateType: 'order',
          aggregateId: id,
          payload: {
            stage: order.stage,
            version: order.version,
            cancelAt: new Date(order.createdAt.getTime() + window).toISOString(),
          },
        });
        return true;
      });
      if (done) reminded += 1;
    }
    return reminded;
  }

  /**
   * Cancels the shop's orders still waiting for their payment, by transfer or online or the
   * advance asked of them, `wait` after they were placed (ADR-168): days, or hours for a shop
   * selling online alone (ADR-657). The oldest first and
   * {@link UNPAID_LIMITS.batch} at most: each in a transaction of its own, by the system, its
   * stock let go. One with a transfer receipt waiting to be checked is left for staff to look at,
   * and those `underway` names, with a payment started online that may still be made, for a
   * later sweep. An order paid or settled since it was found is left as it is. How many it
   * cancelled.
   */
  async cancelUnpaid(
    shopId: string,
    wait: UnpaidWait,
    at: Date = new Date(),
    underway: (orderIds: string[]) => Promise<ReadonlySet<string>> = async () => new Set(),
  ): Promise<number> {
    const { ms, words } = unpaidWait(wait);
    const unpaid = and(
      waitingForPayment(shopId),
      lt(orders.createdAt, new Date(at.getTime() - ms)),
    );
    const found = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(unpaid)
        .orderBy(asc(orders.createdAt))
        .limit(UNPAID_LIMITS.batch),
    );
    if (found.length === 0) return 0;
    const paying = await underway(found.map((order) => order.id));
    let cancelled = 0;
    for (const { id } of found) {
      if (paying.has(id)) continue;
      const done = await this.db.tenant(shopId, async (tx) => {
        const [order] = await tx
          .select()
          .from(orders)
          .where(and(unpaid, eq(orders.id, id)))
          .for('update');
        if (!order) return false;
        const result = await this.cancelLocked(tx, shopId, order, {
          actor: 'system',
          reason: 'unpaid',
          message: `Cancelled: not paid in ${words}`,
        });
        return result.ok;
      });
      if (done) cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Scores again a customer's cash-on-delivery orders still waiting to be confirmed or reviewed
   * and not yet shipped, after their history changed (ADR-112): a parcel of theirs delivered,
   * refused or lost, an order of theirs cancelled, or another customer merged into them. The
   * customer is `about`'s, or the customer of `about`'s order. An order the new score makes risky
   * under the shop's policy waits for review, as when it was placed; one held already stays held.
   * A new score is on the order's timeline, by the system. How many orders it scored differently.
   */
  async rescoreRisk(
    shopId: string,
    about: { customerId: string } | { orderId: string },
  ): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      let customerId: string | undefined;
      if ('customerId' in about) {
        customerId = about.customerId;
      } else {
        const [order] = await tx
          .select({ customerId: orders.customerId })
          .from(orders)
          .where(and(eq(orders.shopId, shopId), eq(orders.id, about.orderId)));
        customerId = order?.customerId;
      }
      if (!customerId) return 0;
      // Locked in one order, so two re-scorings of one customer take turns.
      const waiting = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.shopId, shopId),
            eq(orders.customerId, customerId),
            eq(orders.status, 'open'),
            eq(orders.paymentMethod, 'cash_on_delivery'),
            eq(orders.fulfillmentStatus, 'unfulfilled'),
            inArray(orders.confirmationStatus, ['pending', 'needs_review']),
            isNotNull(orders.riskScore),
          ),
        )
        .orderBy(asc(orders.id))
        .for('update');
      let changed = 0;
      for (const order of waiting) {
        const { assessment, settings } = await assessOrderRisk(tx, shopId, {
          orderId: order.id,
          splitFromId: order.splitFromId,
          customerId,
          total: order.total,
          currency: order.currency as CurrencyCode,
          units: (await parcelSummary(tx, shopId, order.id)).units,
          address: order.shippingAddress as AddressValue,
          placedAt: order.createdAt,
        });
        const previous = order.riskScore!;
        const same =
          assessment.score === previous &&
          assessment.reasons.length === order.riskReasons.length &&
          assessment.reasons.every(
            (reason, index) =>
              reason.code === order.riskReasons[index]!.code &&
              reason.weight === order.riskReasons[index]!.weight &&
              reason.message === order.riskReasons[index]!.message,
          );
        if (same) continue;
        // As at placement: held when the new score is what makes it risky.
        const held =
          order.confirmationStatus === 'pending' &&
          !holdsForRisk(settings, previous) &&
          holdsForRisk(settings, assessment.score);
        const updated = await updateOrder(tx, shopId, order, {
          ...riskColumns(assessment),
          ...(held && { confirmationStatus: 'needs_review' as const }),
        });
        if (assessment.score !== previous) {
          await addTimelineEntry(
            tx,
            shopId,
            order.id,
            'system',
            'rescored',
            rescoredMessage(previous, assessment),
          );
        }
        if (held) {
          await addTimelineEntry(
            tx,
            shopId,
            order.id,
            'system',
            'held',
            heldForRiskMessage(assessment),
          );
        }
        await appendEvent<OrderUpdatedPayload>(tx, shopId, {
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['risk'], stage: updated.stage, version: updated.version },
        });
        changed += 1;
      }
      return changed;
    });
  }

  /**
   * Holds for review a customer's other cash-on-delivery orders confirmed and waiting to be packed
   * or booked, once a parcel of `orderId`'s turns back, refused or not delivered, where the shop
   * says so (COD-07, ADR-674): staff call them, then confirm it to let it go ahead, as for an
   * order held for its risk. Each held says why on its timeline, by the system; held already,
   * packed since or shipped, an order is left as it is. How many it held.
   */
  async holdForRefusal(shopId: string, orderId: string): Promise<number> {
    return this.db.tenant(shopId, async (tx) => {
      if (!(await orderSettingsIn(tx, shopId)).holdWhenRefused) return 0;
      const [refused] = await tx
        .select({ customerId: orders.customerId, number: orders.number })
        .from(orders)
        .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
      if (!refused?.customerId) return 0;
      // Locked in one order, as re-scoring locks them, so the two take turns.
      const toShip = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.shopId, shopId),
            eq(orders.customerId, refused.customerId),
            eq(orders.status, 'open'),
            eq(orders.paymentMethod, 'cash_on_delivery'),
            inArray(orders.stage, ['to_pack', 'to_book']),
            sql`${orders.id} <> ${orderId}`,
          ),
        )
        .orderBy(asc(orders.id))
        .for('update');
      for (const order of toShip) {
        const updated = await updateOrder(tx, shopId, order, {
          confirmationStatus: 'needs_review',
        });
        await addTimelineEntry(
          tx,
          shopId,
          order.id,
          'system',
          'held',
          `Held for review: its customer refused the parcel of ${orderName(Number(refused.number))}`,
        );
        await appendEvent<OrderUpdatedPayload>(tx, shopId, {
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['held'], stage: updated.stage, version: updated.version },
        });
      }
      return toShip.length;
    });
  }

  /**
   * Marks a confirmed or paid order as packed, ready to hand to a courier: it moves from To pack to
   * To book. Shipping does not need it; it is for shops that pack and book in separate steps.
   */
  async markPacked(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      const refusal = packingRefusal(order);
      if (refusal) return failOne(['id'], 'INVALID', refusal);
      if (order.packedAt) return { ok: true, value: order };
      const updated = await updateOrder(tx, tenant.shopId, order, {}, ['packedAt']);
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'packed',
        order.deliveryMethod === 'pickup'
          ? 'Marked as packed, ready for the customer to pick up'
          : 'Marked as packed',
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['packed'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Gives the order to a member of staff to see through, or, with null, takes it from whoever has
   * it (ORD-10, ADR-127). The caller says who: the core checks that they work in the shop, and
   * their name goes on the timeline. Giving it to whoever has it already changes nothing. Without
   * `fromOthers`, which owners, managers and apps have, an order someone else has stays theirs:
   * the caller takes an order no one has, or gives back their own. With `batch`, it is one of
   * many given at once ({@link bulkAssign}), and its event says so.
   */
  async assign(
    tenant: TenantContext,
    id: string,
    assignee: { staffMemberId: string; name: string } | null,
    options: { fromOthers: boolean; batch?: { id: string; size: number } },
  ): Promise<MutationResult<OrderRecord>> {
    return this.#change(
      tenant,
      id,
      ['id'],
      async (tx, order) => {
        if (order.assigneeId === (assignee?.staffMemberId ?? null)) {
          return { ok: true, value: order };
        }
        if (
          !options.fromOthers &&
          order.assigneeId !== null &&
          order.assigneeId !== staffMemberOf(tenant)
        ) {
          return failOne(
            ['id'],
            'INVALID',
            'The order is assigned to someone else; an owner or manager reassigns it',
          );
        }
        const updated = await updateOrder(
          tx,
          tenant.shopId,
          order,
          assignee
            ? { assigneeId: assignee.staffMemberId }
            : { assigneeId: null, assignedAt: null },
          assignee ? ['assignedAt'] : [],
        );
        await addTimelineEntry(
          tx,
          tenant.shopId,
          order.id,
          tenant.actor,
          assignee ? 'assigned' : 'unassigned',
          assignee ? `Assigned to ${assignee.name}` : 'No longer assigned to anyone',
        );
        await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['assignee'], stage: updated.stage, version: updated.version },
        });
        if (assignee) {
          // For the worker to tell them, unless they took it themselves (ADR-191).
          await appendEvent<OrderAssignedPayload>(tx, tenant.shopId, {
            type: OrderEvents.OrderAssigned,
            aggregateType: 'order',
            aggregateId: order.id,
            payload: {
              assigneeId: assignee.staffMemberId,
              assignedBy: staffMemberOf(tenant),
              ...(options.batch ? { batch: options.batch } : {}),
              stage: updated.stage,
              version: updated.version,
            },
          });
        }
        return { ok: true, value: updated };
      },
      { overLimit: 'allow' },
    );
  }

  /**
   * Gives back to no one the open orders of a member of staff who left the shop, each with a
   * timeline entry and an event (ADR-127). Closed and cancelled orders keep whom they were given
   * to. Returns how many went back.
   */
  async release(tenant: TenantContext, staffMemberId: string): Promise<number> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      // Nor are they on duty at the desk any more (ADR-654).
      await endDutyIn(tx, tenant.shopId, staffMemberId);
      const released = await tx
        .update(orders)
        .set({
          assigneeId: null,
          assignedAt: null,
          version: sql`${orders.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(orders.shopId, tenant.shopId),
            eq(orders.assigneeId, staffMemberId),
            eq(orders.status, 'open'),
          ),
        )
        .returning({ id: orders.id, stage: orders.stage, version: orders.version });
      if (released.length === 0) return 0;
      await tx.insert(orderEvents).values(
        released.map((order) => ({
          shopId: tenant.shopId,
          id: newId(),
          orderId: order.id,
          kind: 'unassigned',
          message: 'No longer assigned to anyone: its assignee left the shop',
          ...actorColumns(tenant.actor),
        })),
      );
      await appendEvents<OrderUpdatedPayload>(
        tx,
        tenant.shopId,
        released.map((order) => ({
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['assignee'], stage: order.stage, version: order.version },
        })),
      );
      return released.length;
    });
  }

  /** Takes back a packed mark, e.g. one made by mistake, while nothing has shipped. */
  async markUnpacked(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (!order.packedAt) return { ok: true, value: order };
      if (order.status === 'cancelled') {
        return failOne(['id'], 'INVALID', "A cancelled order can't be unpacked");
      }
      if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(['id'], 'INVALID', 'Only orders that have not shipped can be unpacked');
      }
      const updated = await updateOrder(tx, tenant.shopId, order, { packedAt: null });
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'unpacked',
        'Marked as not packed',
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['packed'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Ships the order from another location (INV-10, ADR-355): its stock committed there and let go
   * where it was, in one change, refused if the new location is short of any of it. Only before it
   * is packed or anything has shipped; the same location changes nothing.
   */
  async changeLocation(
    tenant: TenantContext,
    id: string,
    locationId: string,
  ): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      const { shopId } = tenant;
      if (order.status === 'cancelled') {
        return failOne(['id'], 'INVALID', "A cancelled order doesn't ship from anywhere");
      }
      if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(['id'], 'INVALID', 'Only orders that have not shipped change location');
      }
      if (order.packedAt) {
        return failOne(
          ['id'],
          'INVALID',
          'A packed order ships from where it was packed: mark it not packed first',
        );
      }
      if (order.locationId === locationId) return { ok: true, value: order };
      const location = await this.#location(tx, shopId, locationId, ['locationId'], []);
      if (!location.ok) return { ok: false, errors: [location.error] };
      // Collected where the customer was told to come: only somewhere that offers it (ADR-389).
      if (order.deliveryMethod === 'pickup' && !location.value.localPickup) {
        return failOne(['locationId'], 'INVALID', noPickupAt(location.value.name));
      }
      const orderLines = await tx
        .select({ variantId: lines.variantId, quantity: lines.quantity, title: lines.title })
        .from(lines)
        .where(and(eq(lines.shopId, shopId), eq(lines.orderId, order.id)));
      const moved = await this.stock.recommit(
        tx,
        { shopId, actor: tenant.actor },
        {
          commit: orderLines.map((line) => ({ ...line, locationId })),
          release: orderLines.map((line) => ({ ...line, locationId: order.locationId })),
        },
        { referenceDocumentUri: orderReference(order.id) },
      );
      if (!moved.ok) {
        return {
          ok: false,
          errors: moved.shortages.map((shortage) => {
            const title = orderLines.find((line) => line.variantId === shortage.variantId)!.title;
            const left = Math.max(shortage.available, 0);
            return {
              field: ['locationId'],
              code: 'OUT_OF_STOCK',
              message:
                left === 0
                  ? `"${title}" is out of stock at ${location.value.name}`
                  : `Only ${left} of "${title}" left at ${location.value.name}`,
            };
          }),
        };
      }
      const updated = await updateOrder(tx, shopId, order, { locationId });
      await addTimelineEntry(
        tx,
        shopId,
        order.id,
        tenant.actor,
        'location_changed',
        `Ships from ${location.value.name}`,
      );
      await appendEvent<OrderUpdatedPayload>(tx, shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['location'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /** Confirms many orders; see {@link confirm}. */
  bulkConfirm(tenant: TenantContext, ids: readonly string[]): Promise<MutationResult<BulkResult>> {
    return this.#bulk(ids, (id) => this.confirm(tenant, id));
  }

  /** Cancels many orders, for one reason; see {@link cancel}. */
  bulkCancel(
    tenant: TenantContext,
    ids: readonly string[],
    options: CancelOptions,
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    check.text(['staffNote'], options.staffNote, { max: LIMITS.note });
    if (options.reason === 'merged') {
      check.addMessage(['reason'], 'INVALID', MERGED_ONLY_BY_MERGING);
    }
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    return this.#bulk(ids, (id) => this.cancel(tenant, id, options));
  }

  /**
   * Gives many orders to one member of staff, or to no one; see {@link assign}. Their events
   * share one batch (ADR-634), so whoever is given them is told once, not once an order.
   */
  bulkAssign(
    tenant: TenantContext,
    ids: readonly string[],
    assignee: { staffMemberId: string; name: string } | null,
    options: { fromOthers: boolean },
  ): Promise<MutationResult<BulkResult>> {
    const batch = { id: newId(), size: new Set(ids).size };
    return this.#bulk(ids, (id) => this.assign(tenant, id, assignee, { ...options, batch }));
  }

  /** Marks many orders packed; see {@link markPacked}. */
  bulkMarkPacked(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    return this.#bulk(ids, (id) => this.markPacked(tenant, id));
  }

  /** Adds tags to many orders; tags an order has already, in any case, are left as they are. */
  bulkAddTags(
    tenant: TenantContext,
    ids: readonly string[],
    tags: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    const added = check.tags(['tags'], [...tags]);
    if (added.length === 0) check.add(['tags'], 'BLANK', "can't be blank");
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    return this.#bulk(ids, (id) =>
      this.#retag(tenant, id, (current) => {
        const known = new Set(current.map((tag) => tag.toLowerCase()));
        const fresh = added.filter((tag) => !known.has(tag.toLowerCase()));
        return fresh.length === 0
          ? null
          : { tags: [...current, ...fresh], message: `Added ${tagList(fresh)}` };
      }),
    );
  }

  /** Removes tags from many orders, ignoring case. */
  bulkRemoveTags(
    tenant: TenantContext,
    ids: readonly string[],
    tags: readonly string[],
  ): Promise<MutationResult<BulkResult>> {
    const check = new InputChecker();
    const removed = check.tags(['tags'], [...tags]);
    if (removed.length === 0) check.add(['tags'], 'BLANK', "can't be blank");
    if (!check.ok) return Promise.resolve({ ok: false, errors: check.errors });
    const gone = new Set(removed.map((tag) => tag.toLowerCase()));
    return this.#bulk(ids, (id) =>
      this.#retag(tenant, id, (current) => {
        const kept = current.filter((tag) => !gone.has(tag.toLowerCase()));
        const dropped = current.filter((tag) => gone.has(tag.toLowerCase()));
        return dropped.length === 0 ? null : { tags: kept, message: `Removed ${tagList(dropped)}` };
      }),
    );
  }

  /**
   * Records that the order is paid in full: cash collected at the door, or a transfer received.
   * An order with refunds already, such as a returned advance, stays partially refunded.
   */
  /**
   * Lets a cash-on-delivery order go without the advance it still waits for (ADR-653), as when
   * its customer can't send one and the shop takes the risk: what came of it stays paid, the rest
   * is collected at the door, and the order, the advance no longer the customer's say-so, waits
   * to be confirmed as any order paid on delivery does. Not once anything of it has shipped.
   */
  async waiveAdvance(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order waits for nothing`);
      }
      const owed = order.advanceDue - order.amountPaid;
      if (order.paymentMethod !== 'cash_on_delivery' || owed <= 0n) {
        return failOne(['id'], 'INVALID', 'It waits for no advance');
      }
      if (order.fulfillmentStatus !== 'unfulfilled') {
        return failOne(['id'], 'INVALID', 'Some of it has shipped: its advance stays');
      }
      const updated = await updateOrder(tx, tenant.shopId, order, {
        advanceDue: order.amountPaid,
        codAmount: order.codAmount + owed,
        confirmationStatus:
          order.confirmationStatus === 'not_required' ? 'pending' : order.confirmationStatus,
      });
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'edited',
        `Advance of ${rupees(owed)} waived: ${rupees(updated.codAmount)} to collect at the door`,
      );
      await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderUpdated,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { changed: ['advance'], stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  async markAsPaid(tenant: TenantContext, id: string): Promise<MutationResult<OrderRecord>> {
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.amountPaid === order.total) return { ok: true, value: order };
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
      }
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        {
          financialStatus: order.amountRefunded > 0n ? 'partially_refunded' : 'paid',
          amountPaid: order.total,
        },
        ['paidAt'],
      );
      const received = formatMoney(
        money(order.total - order.amountPaid, order.currency as CurrencyCode),
      );
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'paid',
        `Marked as paid: ${received} received` +
          (order.paymentMethod === 'bank_transfer' ? ' by bank transfer' : ''),
      );
      await appendEvent<OrderPaidPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderPaid,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: {
          amountPaid: order.total.toString(),
          stage: updated.stage,
          version: updated.version,
        },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Records money received for the order, by hand, as Shopify's `orderCreateManualPayment` does:
   * `amount` in the shop's currency, or, left out, what the order waits for by transfer (its
   * advance, or the rest of its total), else the rest. An order waiting for its advance or its
   * transfer moves on once that is in; one paid in full is marked paid.
   */
  async recordPayment(
    tenant: TenantContext,
    id: string,
    input: { amount?: string | null } = {},
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const given = check.price(['amount'], input.amount, tenant.currency);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, id, ['id'], async (tx, order) => {
      if (order.status !== 'open') {
        return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
      }
      const rest = order.total - order.amountPaid;
      const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
      if (rest <= 0n) return failOne(['id'], 'INVALID', 'The order is paid in full');
      const awaited = transferOwed(order);
      const amount = given ?? (awaited > 0n ? awaited : rest);
      if (amount <= 0n || amount > rest) {
        return failOne(['amount'], 'INVALID', `Give an amount up to the ${rupees(rest)} it owes`);
      }
      const paid = order.amountPaid + amount;
      const full = paid === order.total;
      const updated = await updateOrder(
        tx,
        tenant.shopId,
        order,
        {
          amountPaid: paid,
          financialStatus: !full
            ? 'partially_paid'
            : order.amountRefunded > 0n
              ? 'partially_refunded'
              : 'paid',
        },
        full ? ['paidAt'] : [],
      );
      // Its advance, when this is what makes it up.
      const advance = order.advanceDue > 0n && order.amountPaid < order.advanceDue;
      const byTransfer = order.paymentMethod === 'bank_transfer' || advance;
      await addTimelineEntry(
        tx,
        tenant.shopId,
        order.id,
        tenant.actor,
        'paid',
        `Recorded a payment of ${rupees(amount)}` +
          (byTransfer ? ' by bank transfer' : '') +
          (advance && paid >= order.advanceDue ? ': the advance it asked for' : '') +
          (full ? ', paying it in full' : ''),
      );
      await appendEvent<OrderPaidPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderPaid,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { amountPaid: paid.toString(), stage: updated.stage, version: updated.version },
      });
      return { ok: true, value: updated };
    });
  }

  /**
   * Pays an order, or part of it, with its customer's store credit (ADR-185): a debit of their
   * account, the credits that expire soonest first, and a payment on the order, in one
   * transaction. `amount` in the shop's currency, or, left out, as much as the order owes and
   * the credit covers. While the order is open and nothing of it has shipped; paying on
   * delivery, an advance still owed is paid first, and the cash left at the door drops by the
   * rest. Cancelled, the order gives it back.
   */
  async payWithStoreCredit(
    tenant: TenantContext,
    id: string,
    input: { amount?: string | null } = {},
    at: Date = new Date(),
  ): Promise<MutationResult<OrderRecord>> {
    const check = new InputChecker();
    const given = check.price(['amount'], input.amount, tenant.currency);
    if (given === 0n) check.addMessage(['amount'], 'INVALID', 'It must be more than 0');
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.#change(tenant, id, ['id'], (tx, order) =>
      this.payWithStoreCreditIn(tx, tenant, order, given, at),
    );
  }

  /**
   * Pays order `orderId`, just placed through checkout in the caller's transaction, with its
   * customer's store credit, as far as it covers (ADR-186), and no more than `upTo` where the
   * shopper chose how much (ADR-592): what the credit paid, 0 for nothing.
   */
  async payPlacedWithStoreCreditIn(
    tx: Tx,
    shopId: string,
    orderId: string,
    at: Date = new Date(),
    upTo: bigint | null = null,
  ): Promise<bigint> {
    const order = await lockOrder(tx, shopId, orderId);
    if (!order) return 0n;
    // At most what the shopper chose to spend (ADR-592), and what the credit and the order allow.
    let given: bigint | null = null;
    if (upTo !== null) {
      const accounts = await storeCreditAccountsIn(tx, shopId, order.customerId, at);
      const balance = accounts.find((account) => account.currency === order.currency)?.balance;
      given = [upTo, balance ?? 0n, order.total - order.amountPaid].reduce((least, each) =>
        each < least ? each : least,
      );
      if (given <= 0n) return 0n;
    }
    const paid = await this.payWithStoreCreditIn(tx, { shopId, actor: 'system' }, order, given, at);
    return paid.ok ? paid.value.amountPaid - order.amountPaid : 0n;
  }

  /**
   * Pays `order`, locked in the caller's transaction, with its customer's store credit, as
   * {@link payWithStoreCredit} does: `given`, or as much as it owes and the credit covers. By
   * `by.actor`, or the system for a shopper at checkout (ADR-185).
   */
  async payWithStoreCreditIn(
    tx: Tx,
    by: { shopId: string; actor: Actor | 'system' },
    order: OrderRow,
    given: bigint | null,
    at: Date = new Date(),
  ): Promise<MutationResult<OrderRow>> {
    if (order.status !== 'open') {
      return failOne(['id'], 'INVALID', `A ${order.status} order can't be paid`);
    }
    if (order.fulfillmentStatus !== 'unfulfilled') {
      return failOne(
        ['id'],
        'INVALID',
        'An order that has shipped is paid as its parcels were sent: it takes no store credit',
      );
    }
    const currency = order.currency as CurrencyCode;
    const rupees = (value: bigint) => formatMoney(money(value, currency));
    const rest = order.total - order.amountPaid;
    if (rest <= 0n) return failOne(['id'], 'INVALID', 'The order is paid in full');
    const accounts = await storeCreditAccountsIn(tx, by.shopId, order.customerId, at);
    const balance = accounts.find((account) => account.currency === currency)?.balance ?? 0n;
    const amount = given ?? (balance < rest ? balance : rest);
    if (amount > rest) {
      return failOne(['amount'], 'INVALID', `Give an amount up to the ${rupees(rest)} it owes`);
    }
    if (amount === 0n) {
      return failOne(['amount'], 'INSUFFICIENT_FUNDS', 'This customer has no store credit');
    }
    const debited = await debitStoreCreditIn(
      tx,
      by,
      { customerId: order.customerId, currency, amount, orderId: order.id },
      ['amount'],
      at,
    );
    if (!debited.ok) return debited;
    return { ok: true, value: await this.#paidAhead(tx, by, order, amount, 'with store credit') };
  }

  /**
   * Pays order `orderId`, just placed, in the caller's transaction, with gift card `giftCardId`
   * (ADR-449): as much as the order owes and the card has. What it paid, or why the card pays
   * nothing: deactivated, past its day, empty, or gone.
   */
  async payPlacedWithGiftCardIn(
    tx: Tx,
    shopId: string,
    orderId: string,
    giftCardId: string,
    at: Date = new Date(),
  ): Promise<
    | { ok: true; paid: bigint }
    | { ok: false; refusal: 'deactivated' | 'expired' | 'empty' | 'unknown' }
  > {
    const order = await lockOrder(tx, shopId, orderId);
    const card = await giftCardOfIn(tx, shopId, giftCardId, at);
    if (!order || !card) return { ok: false, refusal: 'unknown' };
    const spent = await spendGiftCardIn(
      tx,
      shopId,
      { giftCardId, most: order.total - order.amountPaid, orderId },
      at,
    );
    if (!spent.ok) return spent;
    if (spent.spent > 0n) {
      await this.#paidAhead(
        tx,
        { shopId, actor: 'system' },
        order,
        spent.spent,
        `with gift card •••• ${card.lastCharacters}`,
      );
    }
    return { ok: true, paid: spent.spent };
  }

  /**
   * Records `amount` paid ahead on `order`, locked, `how` it was paid, as with store credit
   * (ADR-185) or a gift card (ADR-449). The order as it is then.
   */
  async #paidAhead(
    tx: Tx,
    by: { shopId: string; actor: Actor | 'system' },
    order: OrderRow,
    amount: bigint,
    how: string,
  ): Promise<OrderRow> {
    const rupees = (value: bigint) => formatMoney(money(value, order.currency as CurrencyCode));
    // An advance still owed is paid first; what is left comes off the cash at the door.
    const owedAhead =
      order.advanceDue > order.amountPaid ? order.advanceDue - order.amountPaid : 0n;
    const offDoor =
      order.paymentMethod === 'cash_on_delivery' && amount > owedAhead
        ? amount - owedAhead < order.codAmount
          ? amount - owedAhead
          : order.codAmount
        : 0n;
    const paid = order.amountPaid + amount;
    const full = paid === order.total;
    const updated = await updateOrder(
      tx,
      by.shopId,
      order,
      {
        amountPaid: paid,
        codAmount: order.codAmount - offDoor,
        financialStatus: !full
          ? 'partially_paid'
          : order.amountRefunded > 0n
            ? 'partially_refunded'
            : 'paid',
      },
      full ? ['paidAt'] : [],
    );
    await addTimelineEntry(
      tx,
      by.shopId,
      order.id,
      by.actor,
      'paid',
      `Paid ${rupees(amount)} ${how}` +
        (full
          ? ', paying it in full'
          : offDoor > 0n
            ? `: ${rupees(updated.codAmount)} is left to collect at the door`
            : ''),
    );
    await appendEvent<OrderPaidPayload>(tx, by.shopId, {
      type: OrderEvents.OrderPaid,
      aggregateType: 'order',
      aggregateId: order.id,
      payload: { amountPaid: paid.toString(), stage: updated.stage, version: updated.version },
    });
    return updated;
  }

  /**
   * Changes an order's tags as `retag` says, reading them under the order's lock so that two bulk
   * changes at once both count. `retag` returns null to leave them as they are.
   */
  async #retag(
    tenant: TenantContext,
    id: string,
    retag: (current: string[]) => { tags: string[]; message: string } | null,
  ): Promise<MutationResult<OrderRecord>> {
    return this.#change(
      tenant,
      id,
      ['id'],
      async (tx, order) => {
        const next = retag(order.tags);
        if (!next) return { ok: true, value: order };
        if (next.tags.length > INPUT_LIMITS.tags) {
          return failOne(['id'], 'TOO_MANY', `An order can have at most ${INPUT_LIMITS.tags} tags`);
        }
        const updated = await updateOrder(tx, tenant.shopId, order, { tags: next.tags });
        await addTimelineEntry(tx, tenant.shopId, order.id, tenant.actor, 'updated', next.message);
        await appendEvent<OrderUpdatedPayload>(tx, tenant.shopId, {
          type: OrderEvents.OrderUpdated,
          aggregateType: 'order',
          aggregateId: order.id,
          payload: { changed: ['tags'], stage: updated.stage, version: updated.version },
        });
        return { ok: true, value: updated };
      },
      { overLimit: 'allow' },
    );
  }

  /**
   * Runs an action on each order in its own transaction, so one that fails leaves the others
   * done: a merchant confirming 37 orders gets 36 confirmed and one reason. IDs given twice count
   * once. Up to {@link LIMITS.batch} at a time.
   */
  async #bulk(
    ids: readonly string[],
    run: (id: string) => Promise<MutationResult<OrderRecord>>,
  ): Promise<MutationResult<BulkResult>> {
    if (ids.length === 0) return failOne(['ids'], 'BLANK', 'Ids must include at least one');
    if (ids.length > LIMITS.batch) {
      return failOne(['ids'], 'TOO_MANY', `Ids can have at most ${LIMITS.batch}`);
    }
    const result: BulkResult = { orders: [], errors: [] };
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const done = await run(id);
      if (done.ok) {
        result.orders.push(done.value);
      } else {
        for (const error of done.errors) {
          result.errors.push({ ...error, field: ['ids', String(index)] });
        }
      }
    }
    return { ok: true, value: result };
  }

  /**
   * Runs `change` on the locked order in one transaction and returns the order as it ends up.
   * `change` returns user errors, or the order row to report.
   */
  /**
   * Changes an order under its lock as `change` says. One past its plan's limit (ADR-263) is
   * refused, unless `overLimit` allows what changes nothing of its customer or its shipping: its
   * note and tags, who has it, and cancelling it.
   */
  async #change(
    tenant: TenantContext,
    id: string,
    idField: string[],
    change: (tx: Tx, order: OrderRow) => Promise<MutationResult<OrderRow>>,
    { overLimit = 'refuse' }: { overLimit?: 'refuse' | 'allow' } = {},
  ): Promise<MutationResult<OrderRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const order = await lockOrder(tx, tenant.shopId, id);
      if (!order) return failOne(idField, 'NOT_FOUND', 'Order not found');
      if (order.overLimitAt && overLimit === 'refuse') {
        return failOne(idField, 'INVALID', OVER_LIMIT_MESSAGE);
      }
      const result = await change(tx, order);
      if (!result.ok) return result;
      return { ok: true, value: (await loadOrder(tx, tenant.shopId, id))! };
    });
  }

  /**
   * Where a pickup order is collected (ADR-389): the location named, which must offer pickup; or,
   * with none named, the one location that does.
   */
  async #pickupLocation(
    tx: Tx,
    shopId: string,
    order: OrderToPlace,
  ): Promise<{ ok: true; value: string } | { ok: false; error: FieldError }> {
    return pickupLocationIn(tx, this.locations, shopId, order.locationId, [
      ...order.field,
      'locationId',
    ]);
  }

  /**
   * The lines an order's become: each bundle's, its parts', its price shared among them by
   * what each costs alone, and the bundle kept on them (ADR-410); any other as it is. A bundle
   * missing a part, or with one archived, is not sold. The snapshots of all their variants.
   */
  async #parts(
    tx: Tx,
    shopId: string,
    asked: readonly OrderToPlace['lines'][number][],
    lineField: (index: number) => string[],
    snapshots: Map<string, VariantSnapshot>,
  ): Promise<{
    lines: PlacingLine[];
    snapshots: Map<string, VariantSnapshot>;
    errors: FieldError[];
  }> {
    const bundles = await bundlesOfVariantsIn(
      tx,
      shopId,
      asked.map((line) => line.variantId),
    );
    if (bundles.size === 0) {
      return {
        lines: asked.map((line, index) => ({ ...line, field: lineField(index), bundle: null })),
        snapshots,
        errors: [],
      };
    }
    const parts = await this.variants.snapshotsOf(
      tx,
      shopId,
      [...bundles.values()].flatMap((bundle) => bundle.components.map((part) => part.variantId)),
    );
    const lines: PlacingLine[] = [];
    const errors: FieldError[] = [];
    asked.forEach((line, index) => {
      const field = lineField(index);
      const bundle = bundles.get(line.variantId);
      const own = snapshots.get(line.variantId);
      if (!bundle || !own) {
        lines.push({ ...line, field, bundle: null });
        return;
      }
      const missing = bundle.components.find((part) => {
        const snapshot = parts.get(part.variantId);
        return !snapshot || snapshot.productStatus === 'archived';
      });
      if (!bundle.complete || missing) {
        errors.push({
          field: [...field, 'variantId'],
          code: 'INVALID',
          message: `"${own.productTitle}" is missing a part, so it can't be sold`,
        });
        return;
      }
      const sold = { key: newId(), title: own.productTitle, quantity: line.quantity };
      const shared = shareBundlePrice(
        line.price ?? own.price,
        line.quantity,
        bundle.components.map((part) => ({
          variantId: part.variantId,
          quantity: part.quantity,
          price: parts.get(part.variantId)!.price,
        })),
      );
      for (const part of shared) {
        lines.push({
          variantId: part.variantId,
          quantity: part.quantity,
          price: part.unitPrice,
          properties: line.properties,
          field,
          bundle: sold,
        });
      }
    });
    return { lines, snapshots: new Map([...snapshots, ...parts]), errors };
  }

  /**
   * The location named, which must be active; or, with none named, the first fulfilling online
   * orders that has all of `lines` for sale, one shipping to where it goes `to` first (ADR-839),
   * the primary otherwise (INV-10, ADR-355).
   */
  async #location(
    tx: Tx,
    shopId: string,
    locationId: string | null,
    field: string[],
    lines: readonly { variantId: string; quantity: number }[],
    to: { city: string; provinceCode: string | null } | null = null,
  ): Promise<{ ok: true; value: LocationRecord } | { ok: false; error: FieldError }> {
    if (!locationId) {
      return { ok: true, value: await this.locations.forOrderIn(tx, shopId, lines, to) };
    }
    const location = (await this.locations.locationsOf(tx, shopId, [locationId])).get(locationId);
    if (!location) {
      return { ok: false, error: { field, code: 'NOT_FOUND', message: 'Location not found' } };
    }
    if (!location.isActive) {
      return {
        ok: false,
        error: { field, code: 'INVALID', message: 'The location is not active' },
      };
    }
    return { ok: true, value: location };
  }
}

/**
 * An e-contract log as the order's columns (ADR-057): the address only if it is one, since behind
 * a proxy it comes from a header anyone can fill in, and the browser's name without control
 * characters, cut to 512 characters.
 */
function agreementColumns(
  agreement: OrderAgreementInput | null,
): Pick<OrderRow, 'agreedPolicyVersions' | 'clientIp' | 'clientUserAgent'> {
  if (!agreement) return { agreedPolicyVersions: null, clientIp: null, clientUserAgent: null };
  return {
    agreedPolicyVersions: agreement.policyVersions,
    clientIp: agreement.ip && isIP(agreement.ip) !== 0 ? agreement.ip : null,
    clientUserAgent: agreement.userAgent?.replace(/\p{Cc}/gu, '').slice(0, 512) || null,
  };
}

/** Why a pickup order cannot be collected at a location (ADR-389). */
/**
 * Where an order or draft the customer picks up is collected (ADR-389, ADR-390): the location
 * named, which must offer pickup; or, with none named, the only one that does.
 */
export async function pickupLocationIn(
  tx: Tx,
  locations: LocationService,
  shopId: string,
  locationId: string | null | undefined,
  field: string[],
): Promise<{ ok: true; value: string } | { ok: false; error: FieldError }> {
  const offering = await locations.pickupLocationsIn(tx, shopId);
  if (locationId) {
    if (offering.some((location) => location.id === locationId)) {
      return { ok: true, value: locationId };
    }
    const named = (await locations.locationsOf(tx, shopId, [locationId])).get(locationId);
    return {
      ok: false,
      error: named
        ? { field, code: 'INVALID', message: noPickupAt(named.name) }
        : { field, code: 'NOT_FOUND', message: 'Location not found' },
    };
  }
  if (offering.length === 1) return { ok: true, value: offering[0]!.id };
  return {
    ok: false,
    error: {
      field,
      code: 'BLANK',
      message:
        offering.length === 0
          ? 'No location offers pickup: let customers pick up at one in its settings'
          : 'Choose where the customer picks the order up',
    },
  };
}

function noPickupAt(name: string): string {
  return `Customers can't pick up at ${name}: let them in the location's settings`;
}

/** Why an order cannot be packed, or null if it can. */
function packingRefusal(order: OrderRow): string | null {
  if (order.status === 'cancelled') return "A cancelled order can't be packed";
  if (order.status !== 'open' || order.fulfillmentStatus !== 'unfulfilled') {
    return 'Only orders that have not shipped can be packed';
  }
  if (
    order.stage === 'needs_confirmation' ||
    order.stage === 'needs_review' ||
    order.stage === 'awaiting_payment'
  ) {
    return 'Only confirmed or paid orders can be packed';
  }
  return null;
}

/** "the tag eid" or "the tags eid, vip", for the timeline. */
function tagList(tags: readonly string[]): string {
  return `${tags.length === 1 ? 'the tag' : 'the tags'} ${tags.join(', ')}`;
}

/**
 * Field by field, either's: Postgres returns jsonb objects with their keys reordered, and an
 * address without a pin has no `location` (ADR-259).
 */
function sameAddress(a: AddressValue, b: StoredAddressValue): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AddressValue>;
  return [...keys].every((key) =>
    key === 'location'
      ? a.location?.latitude === b.location?.latitude &&
        a.location?.longitude === b.location?.longitude
      : (a[key] ?? null) === (b[key] ?? null),
  );
}

const CHANGE_NAMES: Record<string, string> = {
  shippingAddress: 'shipping address',
  email: 'email',
  note: 'note',
  tags: 'tags',
  customer: 'customer',
};

/** The member of staff calling, by their account's ID, for `assignee:me`; null for an app. */
export function staffMemberOf(tenant: TenantContext): string | null {
  return tenant.actor.kind === 'staff' ? tenant.actor.userId : null;
}

/**
 * How long an order waits for its payment before it is cancelled: days, or hours for a shop
 * selling online alone (ADR-657).
 */
export type UnpaidWait = number | { hours: number };

/** The wait in milliseconds, and in words for the timeline. */
function unpaidWait(wait: UnpaidWait): { ms: number; words: string } {
  if (typeof wait === 'number') {
    return { ms: wait * 86_400_000, words: `${wait} ${wait === 1 ? 'day' : 'days'}` };
  }
  return {
    ms: wait.hours * 3_600_000,
    words: `${wait.hours} ${wait.hours === 1 ? 'hour' : 'hours'}`,
  };
}

/**
 * The shop's open orders waiting for their payment, by transfer or online or their advance, with
 * no transfer receipt waiting to be checked (ADR-168, ADR-174).
 */
function waitingForPayment(shopId: string) {
  return and(
    eq(orders.shopId, shopId),
    eq(orders.status, 'open'),
    eq(orders.stage, 'awaiting_payment'),
    sql`NOT EXISTS (SELECT 1 FROM orders.transfer_receipts r
                     WHERE r.shop_id = ${orders.shopId} AND r.order_id = ${orders.id})`,
  );
}

/**
 * A gift message as an order keeps it (CHK-16, ADR-413): trimmed, cut to what a card holds, null
 * when it says nothing.
 */
export function giftMessageOf(message: string | null | undefined): string | null {
  const trimmed = (message ?? '').trim();
  if (trimmed === '') return null;
  return trimmed.length <= LIMITS.giftMessage
    ? trimmed
    : `${trimmed.slice(0, LIMITS.giftMessage - 1)}…`;
}
