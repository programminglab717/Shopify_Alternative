import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  CANCEL_REASONS,
  CONFIRMATION_STATUSES,
  DRAFT_ORDER_STATUSES,
  FINANCIAL_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_SOURCES,
  ORDER_STAGES,
  ORDER_STATUSES,
  PARCEL_CLAIM_STATUSES,
  PARCEL_STATUSES,
  PAYMENT_METHODS,
  REFUND_METHODS,
  RISK_LEVELS,
} from '../schema.js';
import { DraftOrderStatus } from './draft-order.types.js';
import {
  FulfillmentClaimStatus,
  FulfillmentStatus,
  OrderCancelReason,
  OrderConfirmationStatus,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  OrderPaymentMethod,
  OrderRiskLevel,
  OrderSource,
  OrderStage,
  OrderStatus,
  RefundMethod,
} from './order.types.js';

// A value the database holds with no value in the API fails every query that reads it, and nulls
// the list it is in: an order from checkout once did this to the order list.
describe("the orders' API enums", () => {
  it.each([
    ['OrderStage', ORDER_STAGES, OrderStage],
    ['OrderStatus', ORDER_STATUSES, OrderStatus],
    ['OrderConfirmationStatus', CONFIRMATION_STATUSES, OrderConfirmationStatus],
    ['OrderFinancialStatus', FINANCIAL_STATUSES, OrderFinancialStatus],
    ['OrderFulfillmentStatus', FULFILLMENT_STATUSES, OrderFulfillmentStatus],
    ['OrderPaymentMethod', PAYMENT_METHODS, OrderPaymentMethod],
    ['OrderSource', ORDER_SOURCES, OrderSource],
    ['OrderCancelReason', CANCEL_REASONS, OrderCancelReason],
    ['FulfillmentStatus', PARCEL_STATUSES, FulfillmentStatus],
    ['FulfillmentClaimStatus', PARCEL_CLAIM_STATUSES, FulfillmentClaimStatus],
    ['OrderRiskLevel', RISK_LEVELS, OrderRiskLevel],
    ['RefundMethod', REFUND_METHODS, RefundMethod],
    ['DraftOrderStatus', DRAFT_ORDER_STATUSES, DraftOrderStatus],
  ] as const)('%s has a value for each the database holds', (_, stored, api) => {
    const values: string[] = Object.values(api);
    expect(stored.map((value) => value.toUpperCase()).filter((v) => !values.includes(v))).toEqual(
      [],
    );
  });
});
