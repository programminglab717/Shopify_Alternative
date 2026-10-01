import {
  Money,
  PageInfo,
  badUserInput,
  decodeCursor,
  encodeCursor,
  phoneAccess,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, maskPkMobile, type PkProvinceCode } from '@hatti/pk';
import type { RiskSettingsRecord } from '../order-risk.js';
import type {
  DraftOrderRecord,
  FulfillmentRecord,
  OrderEventRecord,
  OrderRecord,
  OrderRiskRecord,
  RefundRecord,
} from '../records.js';
import { draftName, orderName } from '../rules.js';
import type {
  BankAccountValue,
  CancelReasonValue,
  DraftOrderSourceValue,
  DraftOrderStatusValue,
  OrderStageValue,
  PaymentMethodValue,
  RefundMethodValue,
  RiskLevelValue,
  StoredAddressValue,
} from '../schema.js';
import { BankAccount } from './bank-transfer.types.js';
import {
  DraftOrder,
  DraftOrderConnection,
  DraftOrderEdge,
  DraftOrderLineItem,
  DraftOrderStatus,
} from './draft-order.types.js';
import {
  Fulfillment,
  FulfillmentLineItem,
  FulfillmentStatus,
  Order,
  MailingAddress,
  OrderAgreement,
  OrderCancelReason,
  OrderConfirmationStatus,
  OrderConnection,
  OrderCustomerLink,
  OrderEdge,
  OrderEvent,
  OrderEventConnection,
  OrderEventEdge,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  OrderLineItem,
  OrderPaymentMethod,
  OrderRisk,
  OrderRiskLevel,
  OrderRiskReason,
  OrderRiskSettings,
  OrderSource,
  OrderStage,
  OrderStatus,
  Refund,
  RefundMethod,
  TrackingInfo,
} from './order.types.js';

/** The UUID behind a public ID of the given kind, or a BAD_USER_INPUT error. */
export function uuidOf(kind: IdKind, id: string): string {
  const uuid = tryFromPublicId(id, kind);
  if (!uuid) throw badUserInput(`Invalid ${kind} id: ${id.slice(0, 64)}`);
  return uuid;
}

/** The UUID a page cursor carries, or a BAD_USER_INPUT error. */
export function cursorAfter(after: string | null | undefined): string | null {
  if (!after) return null;
  const { id } = decodeCursor(after, ['id']);
  if (!isUuid(id)) throw badUserInput('Invalid cursor');
  return id;
}

export function toStageValue(stage: OrderStage): OrderStageValue {
  return stage.toLowerCase() as OrderStageValue;
}

export function toPaymentMethodValue(method: OrderPaymentMethod): PaymentMethodValue {
  return method.toLowerCase() as PaymentMethodValue;
}

export function toCancelReasonValue(reason: OrderCancelReason): CancelReasonValue {
  return reason.toLowerCase() as CancelReasonValue;
}

export function toRiskLevelValue(level: OrderRiskLevel): RiskLevelValue {
  return level.toLowerCase() as RiskLevelValue;
}

/** A source as a draft takes it; the service refuses those a draft cannot come from. */
export function toDraftSourceValue(source: OrderSource): DraftOrderSourceValue {
  return source.toLowerCase() as DraftOrderSourceValue;
}

export function toDraftStatusValue(status: DraftOrderStatus): DraftOrderStatusValue {
  return status.toLowerCase() as DraftOrderStatusValue;
}

const upper = <T>(value: string) => value.toUpperCase() as T;

/** "0300 ••••567", for staff who see customers' numbers masked. */
function maskPhone(e164: string | null): string | null {
  return e164 === null ? null : maskPkMobile(e164);
}

/**
 * Whether the caller sees customers' numbers masked: everyone but owners, managers and apps
 * (docs/architecture/11-security-and-compliance.md §2.1). Confirmation agents reveal a number
 * with `orderPhoneReveal`, which is logged.
 */
export function hidesPhones(tenant: TenantContext): boolean {
  return phoneAccess(tenant) !== 'full';
}

export function toAddress(address: StoredAddressValue, hidePhone: boolean): MailingAddress {
  const province = address.provinceCode
    ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
    : null;
  const cityLine = [address.city, address.zip].filter(Boolean).join(' ');
  return Object.assign(new MailingAddress(), {
    name: address.name,
    phone: hidePhone ? maskPhone(address.phone) : address.phone,
    address1: address.address1,
    address2: address.address2,
    landmark: address.landmark,
    city: address.city,
    province,
    provinceCode: address.provinceCode,
    zip: address.zip,
    formatted: [
      address.name,
      address.address1,
      address.address2,
      address.landmark,
      cityLine,
      province,
    ].filter((line): line is string => Boolean(line)),
  });
}

export function toOrder(record: OrderRecord, tenant: TenantContext): Order {
  const currency = record.currency as CurrencyCode;
  const amount = (value: bigint) => Money.from(money(value, currency));
  const hidePhone = hidesPhones(tenant);
  const lineItems = record.lines.map((line) =>
    Object.assign(new OrderLineItem(), {
      id: toPublicId('lineItem', line.id),
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: amount(line.unitPrice),
      totalPrice: amount(line.total),
      variantId: toPublicId('variant', line.variantId),
      productId: toPublicId('product', line.productId),
      fulfilledQuantity: line.fulfilledQuantity,
      fulfillableQuantity: record.status === 'open' ? line.quantity - line.fulfilledQuantity : 0,
    }),
  );
  const lineItemsById = new Map(record.lines.map((line, index) => [line.id, lineItems[index]!]));
  return Object.assign(new Order(), {
    id: toPublicId('order', record.id),
    name: orderName(record.number),
    number: record.number,
    stage: upper<OrderStage>(record.stage),
    status: upper<OrderStatus>(record.status),
    confirmationStatus: upper<OrderConfirmationStatus>(record.confirmationStatus),
    financialStatus: upper<OrderFinancialStatus>(record.financialStatus),
    fulfillmentStatus: upper<OrderFulfillmentStatus>(record.fulfillmentStatus),
    paymentMethod: upper<OrderPaymentMethod>(record.paymentMethod),
    source: upper<OrderSource>(record.source),
    phone: hidePhone ? maskPhone(record.phone) : record.phone,
    email: record.email,
    shippingAddress: toAddress(record.shippingAddress, hidePhone),
    lineItems,
    fulfillments: record.fulfillments.map((parcel) => toFulfillment(parcel, lineItemsById)),
    refunds: record.refunds.map((refund) => toRefund(refund, currency)),
    subtotalPrice: amount(record.subtotal),
    totalDiscounts: amount(record.discount),
    discountCodes: record.discountCodes,
    transferDiscount: amount(record.transferDiscount),
    totalShippingPrice: amount(record.shipping),
    codFee: amount(record.codFee),
    totalPrice: amount(record.total),
    amountPaid: amount(record.amountPaid),
    amountRefunded: amount(record.amountRefunded),
    codAmount: amount(record.codAmount),
    bankAccount: record.bankAccount && toBankAccount(record.bankAccount),
    note: record.note,
    tags: record.tags,
    cancelReason: record.cancelReason ? upper<OrderCancelReason>(record.cancelReason) : null,
    risk: record.risk ? toOrderRisk(record.risk) : null,
    customerErasedAt: record.customerErasedAt,
    agreement: record.agreement
      ? Object.assign(new OrderAgreement(), {
          agreedAt: record.createdAt,
          ip: hidePhone ? null : record.agreement.ip,
          userAgent: hidePhone ? null : record.agreement.userAgent,
          policyVersionIds: record.agreement.policyVersions,
        })
      : null,
    customerLink: record.link
      ? Object.assign(new OrderCustomerLink(), { expiresAt: record.link.expiresAt })
      : null,
    confirmedAt: record.confirmedAt,
    packedAt: record.packedAt,
    cancelledAt: record.cancelledAt,
    paidAt: record.paidAt,
    closedAt: record.closedAt,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uuid: record.id,
    locationId: record.locationId,
    customerId: record.customerId,
  });
}

export function toBankAccount(account: BankAccountValue): BankAccount {
  return Object.assign(new BankAccount(), {
    title: account.title,
    bankName: account.bankName,
    iban: account.iban,
    instructions: account.instructions,
    raastId: account.raastId,
  });
}

/** Scores are points out of 100 inside Hatti, and 0 to 1 in the API. */
function toOrderRisk(risk: OrderRiskRecord): OrderRisk {
  return Object.assign(new OrderRisk(), {
    score: risk.score / 100,
    level: upper<OrderRiskLevel>(risk.level),
    reasons: risk.reasons.map((reason) =>
      Object.assign(new OrderRiskReason(), {
        code: reason.code,
        message: reason.message,
        weight: reason.weight / 100,
      }),
    ),
  });
}

export function toRiskSettings(
  record: RiskSettingsRecord,
  currency: CurrencyCode,
): OrderRiskSettings {
  return Object.assign(new OrderRiskSettings(), {
    holdAt: record.holdAt === null ? null : record.holdAt / 100,
    highValue: Money.from(money(record.highValue, currency)),
    updatedAt: record.updatedAt,
  });
}

export function toFulfillment(
  record: FulfillmentRecord,
  lineItemsById: ReadonlyMap<string, OrderLineItem>,
): Fulfillment {
  return Object.assign(new Fulfillment(), {
    id: toPublicId('fulfillment', record.id),
    status: upper<FulfillmentStatus>(record.status),
    trackingInfo: Object.assign(new TrackingInfo(), {
      company: record.trackingCompany,
      number: record.trackingNumber,
      url: record.trackingUrl,
    }),
    fulfillmentLineItems: record.lines.map((line) =>
      Object.assign(new FulfillmentLineItem(), {
        lineItem: lineItemsById.get(line.lineId)!,
        quantity: line.quantity,
        restockedQuantity: line.restockedQuantity,
      }),
    ),
    shippedAt: record.shippedAt,
    deliveredAt: record.deliveredAt,
    returningAt: record.returningAt,
    returnedAt: record.returnedAt,
    lostAt: record.lostAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    locationId: record.locationId,
  });
}

export function toOrderConnection(
  records: OrderRecord[],
  hasNextPage: boolean,
  tenant: TenantContext,
): OrderConnection {
  const nodes = records.map((record) => toOrder(record, tenant));
  const edges = nodes.map((node, index) =>
    Object.assign(new OrderEdge(), { node, cursor: encodeCursor({ id: records[index]!.id }) }),
  );
  return Object.assign(new OrderConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toOrderEventConnection(
  records: OrderEventRecord[],
  hasNextPage: boolean,
): OrderEventConnection {
  const nodes = records.map((record) =>
    Object.assign(new OrderEvent(), {
      id: toPublicId('orderEvent', record.id),
      kind: record.kind,
      message: record.message,
      createdAt: record.createdAt,
    }),
  );
  const edges = nodes.map((node, index) =>
    Object.assign(new OrderEventEdge(), { node, cursor: encodeCursor({ id: records[index]!.id }) }),
  );
  return Object.assign(new OrderEventConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}

export function toRefund(record: RefundRecord, currency: CurrencyCode): Refund {
  return Object.assign(new Refund(), {
    id: toPublicId('refund', record.id),
    amount: Money.from(money(record.amount, currency)),
    method: upper<RefundMethod>(record.method),
    reference: record.reference,
    note: record.note,
    createdAt: record.createdAt,
  });
}

export function toRefundMethodValue(method: RefundMethod): RefundMethodValue {
  return method.toLowerCase() as RefundMethodValue;
}

export function toDraftOrder(record: DraftOrderRecord, tenant: TenantContext): DraftOrder {
  const amount = (value: bigint) => Money.from(money(value, record.currency));
  const hidePhone = hidesPhones(tenant);
  return Object.assign(new DraftOrder(), {
    id: toPublicId('draftOrder', record.id),
    name: draftName(record.number),
    number: record.number,
    status: upper<DraftOrderStatus>(record.status),
    source: upper<OrderSource>(record.source),
    paymentMethod: upper<OrderPaymentMethod>(record.paymentMethod),
    lineItems: record.lines.map((line) =>
      Object.assign(new DraftOrderLineItem(), {
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: amount(line.unitPrice),
        totalPrice: amount(line.total),
        variantId: toPublicId('variant', line.variantId),
        productId: toPublicId('product', line.productId),
      }),
    ),
    phone: hidePhone ? maskPhone(record.phone) : record.phone,
    email: record.email,
    shippingAddress: record.shippingAddress ? toAddress(record.shippingAddress, hidePhone) : null,
    subtotalPrice: amount(record.subtotal),
    totalDiscounts: amount(record.discount),
    totalShippingPrice: amount(record.shipping),
    totalPrice: amount(record.total),
    advancePaid: amount(record.advancePaid),
    codAmount: amount(record.codAmount),
    note: record.note,
    tags: record.tags,
    linkExpiresAt: record.linkExpiresAt,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    locationId: record.locationId,
    orderId: record.orderId,
  });
}

export function toDraftOrderConnection(
  records: DraftOrderRecord[],
  hasNextPage: boolean,
  tenant: TenantContext,
): DraftOrderConnection {
  const nodes = records.map((record) => toDraftOrder(record, tenant));
  const edges = nodes.map((node, index) =>
    Object.assign(new DraftOrderEdge(), { node, cursor: encodeCursor({ id: records[index]!.id }) }),
  );
  return Object.assign(new DraftOrderConnection(), {
    edges,
    nodes,
    pageInfo: Object.assign(new PageInfo(), {
      hasNextPage,
      endCursor: edges.at(-1)?.cursor ?? null,
    }),
  });
}
