import {
  Money,
  PageInfo,
  badUserInput,
  decodeCursor,
  encodeCursor,
  type TenantContext,
} from '@hatti/api';
import { isUuid, toPublicId, tryFromPublicId, type IdKind } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { PK_PROVINCES, type PkProvinceCode } from '@hatti/pk';
import type { RiskSettingsRecord } from '../order-risk.js';
import type {
  FulfillmentRecord,
  OrderEventRecord,
  OrderRecord,
  OrderRiskRecord,
} from '../records.js';
import { orderName } from '../rules.js';
import type {
  AddressValue,
  CancelReasonValue,
  OrderStageValue,
  PaymentMethodValue,
  RiskLevelValue,
} from '../schema.js';
import {
  Fulfillment,
  FulfillmentLineItem,
  FulfillmentStatus,
  Order,
  MailingAddress,
  OrderCancelReason,
  OrderConfirmationStatus,
  OrderConnection,
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

const upper = <T>(value: string) => value.toUpperCase() as T;

/**
 * Packers pack and book parcels without seeing customers' numbers
 * (docs/design/02-information-architecture.md §6): "0300 ••••567".
 */
function maskPhone(e164: string): string {
  const subscriber = e164.replace(/^\+92/, '');
  return `0${subscriber.slice(0, 3)} ••••${subscriber.slice(-3)}`;
}

export function hidesPhones(tenant: TenantContext): boolean {
  return tenant.actor.kind === 'staff' && tenant.actor.role === 'packer';
}

export function toAddress(address: AddressValue, hidePhone: boolean): MailingAddress {
  const province = address.provinceCode
    ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
    : null;
  const cityLine = [address.city, address.zip].filter(Boolean).join(' ');
  return Object.assign(new MailingAddress(), {
    name: address.name,
    phone: hidePhone ? maskPhone(address.phone) : address.phone,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province,
    provinceCode: address.provinceCode,
    zip: address.zip,
    formatted: [address.name, address.address1, address.address2, cityLine, province].filter(
      (line): line is string => Boolean(line),
    ),
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
    subtotalPrice: amount(record.subtotal),
    totalDiscounts: amount(record.discount),
    totalShippingPrice: amount(record.shipping),
    totalPrice: amount(record.total),
    amountPaid: amount(record.amountPaid),
    codAmount: amount(record.codAmount),
    note: record.note,
    tags: record.tags,
    cancelReason: record.cancelReason ? upper<OrderCancelReason>(record.cancelReason) : null,
    risk: record.risk ? toOrderRisk(record.risk) : null,
    confirmedAt: record.confirmedAt,
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
