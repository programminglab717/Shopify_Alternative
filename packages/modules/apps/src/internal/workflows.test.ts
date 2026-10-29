import type { DomainEvent } from '@hatti/events';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FIELDS,
  ORDER_FIELDS,
  conditionProblem,
  conditionsHold,
  dueSlot,
  fieldsOf,
  holds,
  placeholdersOf,
  render,
  retagged,
  subjectsOf,
  triggersOf,
  type WorkflowCondition,
} from './workflows.js';

const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent => ({
  id: 'event-1',
  type,
  shopId: 'shop-1',
  aggregateType: type.split('.')[0]!,
  aggregateId: 'aggregate-1',
  payload,
  occurredAt: '2026-10-28T10:00:00.000Z',
});

const when = (field: string, operator: WorkflowCondition['operator'], value: string) => ({
  field,
  operator,
  value,
});

describe('Workflows (DEV-11, ADR-861)', () => {
  it("makes an order's triggers of its events, and a parcel's of its status changing alone", () => {
    expect(triggersOf(event('order.created'))).toEqual([
      {
        trigger: 'order_created',
        extensionId: null,
        subject: { orderId: 'aggregate-1', customerId: null, properties: {} },
      },
    ]);
    expect(triggersOf(event('order.paid'))[0]!.trigger).toBe('order_paid');
    const parcel = (status: string, changed: string[]) =>
      triggersOf(event('fulfillment.updated', { orderId: 'order-9', status, changed }));
    expect(parcel('delivered', ['status'])).toEqual([
      {
        trigger: 'order_delivered',
        extensionId: null,
        subject: { orderId: 'order-9', customerId: null, properties: {} },
      },
    ]);
    expect(parcel('returned', ['status'])[0]!.trigger).toBe('order_returned');
    expect(parcel('delivered', ['tracking'])).toEqual([]);
    expect(parcel('in_transit', ['status'])).toEqual([]);
    expect(triggersOf(event('order.updated'))).toEqual([]);
  });

  it("makes a customer's trigger, and an app's with what it sent", () => {
    expect(triggersOf(event('customer.created'))[0]).toMatchObject({
      trigger: 'customer_created',
      subject: { orderId: null, customerId: 'aggregate-1' },
    });
    expect(
      triggersOf(
        event('flow.trigger_received', {
          orderId: 'order-3',
          customerId: null,
          properties: { rating: '2' },
        }),
      ),
    ).toEqual([
      {
        trigger: 'app',
        extensionId: 'aggregate-1',
        subject: { orderId: 'order-3', customerId: null, properties: { rating: '2' } },
      },
    ]);
  });

  it("makes a variant's stock triggers of its alert, with what it tells as facts (ADR-905)", () => {
    const alerted = (state: string, sku: string | null) =>
      triggersOf(
        event('stock.alerted', {
          productId: 'product-1',
          state,
          available: state === 'out' ? 0 : 3,
          threshold: 5,
          productTitle: 'Lawn suit',
          variantTitle: 'Maroon',
          sku,
        }),
      );
    expect(alerted('low', 'LS-12')).toEqual([
      {
        trigger: 'stock_low',
        extensionId: null,
        subject: {
          orderId: null,
          customerId: null,
          properties: {
            product: 'Lawn suit',
            variant: 'Maroon',
            sku: 'LS-12',
            available: '3',
            threshold: '5',
          },
        },
      },
    ]);
    expect(alerted('out', null)[0]).toMatchObject({
      trigger: 'stock_out',
      subject: { properties: { sku: '', available: '0' } },
    });
    expect(fieldsOf('stock_out', null)).toEqual([
      { key: 'trigger.product', type: 'text' },
      { key: 'trigger.variant', type: 'text' },
      { key: 'trigger.sku', type: 'text' },
      { key: 'trigger.available', type: 'number' },
      { key: 'trigger.threshold', type: 'number' },
    ]);
    expect(subjectsOf('stock_low', null)).toEqual({ order: false, customer: false });
  });

  it("finds a schedule's slot due at its hour of the shop's own time, for two hours (ADR-906)", () => {
    // Wednesdays and Saturdays at 9 in Karachi, five hours ahead of UTC.
    const schedule = { days: [3, 6], hour: 9 };
    const at = (iso: string) => dueSlot(schedule, 'Asia/Karachi', new Date(iso));
    expect(at('2026-10-28T04:30:00Z')).toEqual(new Date('2026-10-28T04:00:00Z'));
    expect(at('2026-10-28T04:00:00Z')).toEqual(new Date('2026-10-28T04:00:00Z'));
    expect(at('2026-10-28T06:00:00Z')).toEqual(new Date('2026-10-28T04:00:00Z'));
    // Before its hour, more than two hours after, or on another day: none.
    expect(at('2026-10-28T03:59:00Z')).toBeNull();
    expect(at('2026-10-28T06:01:00Z')).toBeNull();
    expect(at('2026-10-29T04:30:00Z')).toBeNull();
    // Saturday's, and in another zone its own hour.
    expect(at('2026-10-31T04:10:00Z')).toEqual(new Date('2026-10-31T04:00:00Z'));
    expect(
      dueSlot({ days: [3], hour: 9 }, 'Europe/London', new Date('2026-10-28T09:30:00Z')),
    ).toEqual(new Date('2026-10-28T09:00:00Z'));
    expect(fieldsOf('scheduled', null).map((field) => field.key)).toEqual([
      'trigger.orders_to_confirm',
      'trigger.orders_to_review',
      'trigger.orders_to_pack',
      'trigger.orders_to_book',
      'trigger.variants_low',
      'trigger.variants_out',
    ]);
  });

  it("reads an order's and customer's facts, and an app's trigger's own", () => {
    expect(fieldsOf('order_created', null)).toEqual([...ORDER_FIELDS, ...CUSTOMER_FIELDS]);
    expect(fieldsOf('customer_created', null)).toEqual(CUSTOMER_FIELDS);
    expect(
      fieldsOf('app', {
        resource: 'none',
        fields: [{ key: 'rating', label: 'Rating', type: 'number', required: true }],
      }),
    ).toEqual([{ key: 'trigger.rating', type: 'number' }]);
    expect(subjectsOf('customer_created', null)).toEqual({ order: false, customer: true });
    expect(subjectsOf('app', 'order')).toEqual({ order: true, customer: true });
    expect(subjectsOf('app', null)).toEqual({ order: false, customer: false });
  });

  it('checks a condition: a field the trigger tells of, its operator, a value of its type', () => {
    const fields = fieldsOf('order_created', null);
    expect(conditionProblem(fields, when('order.total', 'at_least', '2,000'))).toEqual({
      on: 'value',
      message: 'must be a number',
    });
    expect(conditionProblem(fields, when('order.total', 'at_least', '2000'))).toBeNull();
    expect(conditionProblem(fields, when('order.tags', 'equals', 'vip'))).toEqual({
      on: 'operator',
      message: "can't compare a list",
    });
    expect(conditionProblem(fields, when('order.payment_method', 'equals', 'cod'))).toEqual({
      on: 'value',
      message: 'must be one of cash_on_delivery, prepaid, bank_transfer, online',
    });
    expect(conditionProblem(fields, when('trigger.rating', 'equals', '1'))).toMatchObject({
      on: 'field',
    });
    expect(conditionProblem(fields, when('order.city', 'contains', ' '))).toEqual({
      on: 'value',
      message: "can't be blank",
    });
  });

  it('tests conditions of facts, ignoring case, a fact not known holding for "not" alone', () => {
    const facts = {
      'order.total': 2499.5,
      'order.city': 'Lahore',
      'order.tags': ['VIP', 'gift'],
      'order.risk_level': 'high',
      'customer.name': null,
      'trigger.verified': true,
    };
    expect(holds(when('order.total', 'at_least', '2499.5'), facts)).toBe(true);
    expect(holds(when('order.total', 'greater_than', '2499.5'), facts)).toBe(false);
    expect(holds(when('order.total', 'less_than', '3000'), facts)).toBe(true);
    expect(holds(when('order.city', 'equals', 'lahore'), facts)).toBe(true);
    expect(holds(when('order.city', 'contains', 'HOR'), facts)).toBe(true);
    expect(holds(when('order.city', 'not_contains', 'kar'), facts)).toBe(true);
    expect(holds(when('order.tags', 'includes', 'vip'), facts)).toBe(true);
    expect(holds(when('order.tags', 'excludes', 'vip'), facts)).toBe(false);
    expect(holds(when('customer.name', 'equals', 'Ali'), facts)).toBe(false);
    expect(holds(when('customer.name', 'not_equals', 'Ali'), facts)).toBe(true);
    expect(holds(when('trigger.verified', 'equals', 'true'), facts)).toBe(true);
    const risky = when('order.risk_level', 'equals', 'high');
    const far = when('order.city', 'equals', 'Quetta');
    expect(conditionsHold('all', [risky, far], facts)).toBe(false);
    expect(conditionsHold('any', [risky, far], facts)).toBe(true);
    expect(conditionsHold('all', [], facts)).toBe(true);
  });

  it("fills a template's placeholders, and changes tags ignoring case", () => {
    const template = 'Order {{order.name}} ({{ order.tags }}) for {{customer.name}}';
    expect(placeholdersOf(template)).toEqual(['order.name', 'order.tags', 'customer.name']);
    expect(render(template, { 'order.name': '#1001', 'order.tags': ['vip', 'gift'] })).toBe(
      'Order #1001 (vip, gift) for ',
    );
    expect(retagged(['VIP', 'gift'], { add: ['vip', 'cod'] })).toEqual(['VIP', 'gift', 'cod']);
    expect(retagged(['VIP', 'gift'], { remove: ['vip'] })).toEqual(['gift']);
  });
});
