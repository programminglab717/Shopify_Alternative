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
import type { OrderEventRecord, OrderRecord } from '../records.js';
import { orderName } from '../rules.js';
import type {
  AddressValue,
  CancelReasonValue,
  OrderStageValue,
  PaymentMethodValue,
} from '../schema.js';
import {
  Order,
  OrderAddress,
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
  OrderSource,
  OrderStage,
  OrderStatus,
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

const upper = <T>(value: string) => value.toUpperCase() as T;

/**
 * Packers pack and book parcels without seeing customers' numbers
 * (docs/design/02-information-architecture.md §6): "0300 ••••567".
 */
function maskPhone(e164: string): string {
  const subscriber = e164.replace(/^\+92/, '');
  return `0${subscriber.slice(0, 3)} ••••${subscriber.slice(-3)}`;
}

function hidesPhones(tenant: TenantContext): boolean {
  return tenant.actor.kind === 'staff' && tenant.actor.role === 'packer';
}

function toAddress(address: AddressValue, hidePhone: boolean): OrderAddress {
  const province = address.provinceCode
    ? PK_PROVINCES[address.provinceCode as PkProvinceCode].name
    : null;
  const cityLine = [address.city, address.zip].filter(Boolean).join(' ');
  return Object.assign(new OrderAddress(), {
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
    lineItems: record.lines.map((line) =>
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
      }),
    ),
    subtotalPrice: amount(record.subtotal),
    totalDiscounts: amount(record.discount),
    totalShippingPrice: amount(record.shipping),
    totalPrice: amount(record.total),
    amountPaid: amount(record.amountPaid),
    codAmount: amount(record.codAmount),
    note: record.note,
    tags: record.tags,
    cancelReason: record.cancelReason ? upper<OrderCancelReason>(record.cancelReason) : null,
    confirmedAt: record.confirmedAt,
    cancelledAt: record.cancelledAt,
    paidAt: record.paidAt,
    closedAt: record.closedAt,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uuid: record.id,
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
