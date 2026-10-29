import type { DomainEvent } from '@hatti/events';

// Workflows (DEV-11, ADR-861): a shop's own automations, as Shopify Flow's are. A trigger, the
// conditions that must hold of what it is about, and the actions done in turn. What is pure is
// here: the triggers and the events that make them, the facts conditions read, how conditions
// are checked when a workflow is saved and tested when it runs, and the actions' templates.

export const WORKFLOW_LIMITS = {
  /** Workflows a shop keeps. */
  perShop: 50,
  name: 100,
  conditions: 10,
  /** Actions done in turn, waits and checks among them (ADR-886). */
  actions: 10,
  /** The longest a wait waits, in hours: a week. */
  waitHours: 168,
  /** A condition's value, and a template's. */
  value: 200,
  title: 80,
  message: 500,
  /** Tags an action adds or takes away. */
  tags: 10,
  /** Triggers and actions an app offers, each. */
  extensionsPerApp: 20,
  handle: 50,
  description: 300,
  url: 500,
  /** Fields an app's trigger sends, or its action is sent. */
  fields: 20,
  fieldKey: 40,
  /** What an app sends with a field of its trigger. */
  property: 1_000,
  /** Runs of a workflow in an hour; past that, its trigger is not heard until the hour is up. */
  runsPerHour: 500,
  /** How long runs are kept. */
  keptDays: 30,
  /** Runs a sweep takes up. */
  batch: 25,
  /** How long an app's action is tried for, from when the run was made or last waited till. */
  triesForMs: 24 * 3_600_000,
} as const;

/** Hatti's own triggers, what each is about, and an app's. */
export const WORKFLOW_TRIGGERS = {
  order_created: { subject: 'order' },
  order_confirmed: { subject: 'order' },
  order_paid: { subject: 'order' },
  order_cancelled: { subject: 'order' },
  order_delivered: { subject: 'order' },
  order_returned: { subject: 'order' },
  customer_created: { subject: 'customer' },
  // A variant fallen to the shop's low-stock line, or run out (ADR-905): about no order or
  // customer, what it tells being its facts.
  stock_low: { subject: null },
  stock_out: { subject: null },
  app: { subject: null },
} as const satisfies Record<string, { subject: 'order' | 'customer' | null }>;

export type WorkflowTrigger = keyof typeof WORKFLOW_TRIGGERS;
export const WORKFLOW_TRIGGER_NAMES = Object.keys(WORKFLOW_TRIGGERS) as WorkflowTrigger[];

export function isWorkflowTrigger(value: string): value is WorkflowTrigger {
  return Object.hasOwn(WORKFLOW_TRIGGERS, value);
}

/** What a resource of an app's trigger or action is. */
export const FLOW_RESOURCES = ['order', 'customer', 'none'] as const;
export type FlowResource = (typeof FLOW_RESOURCES)[number];

/** The event an app's trigger fired makes: its aggregate is the trigger, the extension. */
export const FlowEvents = {
  TriggerReceived: 'flow.trigger_received',
} as const;

export interface FlowTriggerReceivedPayload {
  orderId: string | null;
  customerId: string | null;
  properties: Record<string, string>;
}

/** What a run is about: the order or customer, and what an app's trigger sent. */
export interface WorkflowSubject {
  orderId: string | null;
  customerId: string | null;
  properties: Record<string, string>;
}

/** The triggers an event makes, each with what it is about; none for most events. */
export function triggersOf(
  event: DomainEvent,
): { trigger: WorkflowTrigger; extensionId: string | null; subject: WorkflowSubject }[] {
  const payload = event.payload as Record<string, unknown>;
  const order = (trigger: WorkflowTrigger, orderId: string) => [
    { trigger, extensionId: null, subject: { orderId, customerId: null, properties: {} } },
  ];
  switch (event.type) {
    case 'order.created':
      return order('order_created', event.aggregateId);
    case 'order.confirmed':
      return order('order_confirmed', event.aggregateId);
    case 'order.paid':
      return order('order_paid', event.aggregateId);
    case 'order.cancelled':
      return order('order_cancelled', event.aggregateId);
    case 'fulfillment.updated': {
      const changed = Array.isArray(payload.changed) ? payload.changed : [];
      if (!changed.includes('status') || typeof payload.orderId !== 'string') return [];
      if (payload.status === 'delivered') return order('order_delivered', payload.orderId);
      if (payload.status === 'returned') return order('order_returned', payload.orderId);
      return [];
    }
    // As the shop's low-stock alert tells it, once a spell (ADR-905).
    case 'stock.alerted': {
      const sku = typeof payload.sku === 'string' ? payload.sku : '';
      return [
        {
          trigger: payload.state === 'out' ? 'stock_out' : 'stock_low',
          extensionId: null,
          subject: {
            orderId: null,
            customerId: null,
            properties: {
              product: String(payload.productTitle ?? ''),
              variant: String(payload.variantTitle ?? ''),
              sku,
              available: String(payload.available ?? 0),
              threshold: String(payload.threshold ?? 0),
            },
          },
        },
      ];
    }
    case 'customer.created':
      return [
        {
          trigger: 'customer_created',
          extensionId: null,
          subject: { orderId: null, customerId: event.aggregateId, properties: {} },
        },
      ];
    case FlowEvents.TriggerReceived: {
      const sent = payload as Partial<FlowTriggerReceivedPayload>;
      return [
        {
          trigger: 'app',
          extensionId: event.aggregateId,
          subject: {
            orderId: sent.orderId ?? null,
            customerId: sent.customerId ?? null,
            properties: sent.properties ?? {},
          },
        },
      ];
    }
    default:
      return [];
  }
}

/** The events workflows are triggered by. */
export const WORKFLOW_EVENTS: readonly string[] = [
  'order.created',
  'order.confirmed',
  'order.paid',
  'order.cancelled',
  'fulfillment.updated',
  'customer.created',
  'stock.alerted',
  FlowEvents.TriggerReceived,
];

/** What a fact is: a number, words, one of some words, a list of words, or yes or no. */
export type FactType = 'number' | 'text' | 'choice' | 'list' | 'boolean';
export type FactValue = number | string | boolean | string[] | null;
export type Facts = Readonly<Record<string, FactValue>>;

export interface FactField {
  key: string;
  type: FactType;
  /** A choice's words. */
  options?: readonly string[];
}

/** What a condition may read of an order: in rupees where it is money. */
export const ORDER_FIELDS: readonly FactField[] = [
  { key: 'order.number', type: 'number' },
  { key: 'order.name', type: 'text' },
  { key: 'order.total', type: 'number' },
  { key: 'order.item_count', type: 'number' },
  {
    key: 'order.payment_method',
    type: 'choice',
    options: ['cash_on_delivery', 'prepaid', 'bank_transfer', 'online'],
  },
  {
    key: 'order.source',
    type: 'choice',
    options: [
      'online_store',
      'whatsapp',
      'instagram',
      'facebook',
      'pos',
      'manual',
      'api',
      'marketplace',
      'reseller',
    ],
  },
  { key: 'order.delivery_method', type: 'choice', options: ['shipping', 'pickup'] },
  // Where the order is now, as the admin shows it, and its confirmation (ADR-886): read again
  // after a wait, "is it still waiting to be confirmed?".
  {
    key: 'order.stage',
    type: 'choice',
    options: [
      'needs_confirmation',
      'needs_review',
      'awaiting_payment',
      'to_pack',
      'to_book',
      'ready_for_pickup',
      'partially_fulfilled',
      'in_transit',
      'returning',
      'delivered',
      'returned',
      'lost',
      'completed',
      'cancelled',
    ],
  },
  {
    key: 'order.confirmation_status',
    type: 'choice',
    options: ['not_required', 'pending', 'confirmed', 'rejected', 'no_response', 'needs_review'],
  },
  { key: 'order.risk_level', type: 'choice', options: ['low', 'medium', 'high', 'none'] },
  { key: 'order.city', type: 'text' },
  { key: 'order.tags', type: 'list' },
  { key: 'order.discount_codes', type: 'list' },
  { key: 'order.skus', type: 'list' },
];

/** What a condition may read of a customer, the order's or the one the trigger names. */
export const CUSTOMER_FIELDS: readonly FactField[] = [
  { key: 'customer.name', type: 'text' },
  { key: 'customer.tags', type: 'list' },
  { key: 'customer.orders_count', type: 'number' },
  { key: 'customer.amount_spent', type: 'number' },
  { key: 'customer.returned_orders', type: 'number' },
];

/** A field an app's trigger sends, or its action is sent. */
export interface FlowField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  required: boolean;
}

/** What a variant's stock trigger tells (ADR-905), each fact `trigger.<key>`. */
const STOCK_FIELDS: readonly FlowField[] = [
  { key: 'product', label: 'Product', type: 'text', required: true },
  { key: 'variant', label: 'Variant', type: 'text', required: true },
  { key: 'sku', label: 'SKU', type: 'text', required: false },
  { key: 'available', label: 'Units left for sale online', type: 'number', required: true },
  { key: 'threshold', label: "The shop's low-stock line", type: 'number', required: true },
];

/** What Hatti's own triggers tell beside an order or customer, as an app's trigger's fields. */
export const TRIGGER_FIELDS: Partial<Record<WorkflowTrigger, readonly FlowField[]>> = {
  stock_low: STOCK_FIELDS,
  stock_out: STOCK_FIELDS,
};

/** The facts a workflow on `trigger` reads: of its order and customer, and what the app sends. */
export function fieldsOf(
  trigger: WorkflowTrigger,
  extension: { resource: FlowResource; fields: readonly FlowField[] } | null,
): FactField[] {
  const subject =
    trigger === 'app' ? (extension?.resource ?? 'none') : WORKFLOW_TRIGGERS[trigger].subject;
  return [
    ...(subject === 'order' ? ORDER_FIELDS : []),
    ...(subject === 'order' || subject === 'customer' ? CUSTOMER_FIELDS : []),
    ...(trigger === 'app' ? (extension?.fields ?? []) : (TRIGGER_FIELDS[trigger] ?? [])).map(
      (field) => ({ key: `trigger.${field.key}`, type: field.type }),
    ),
  ];
}

export const CONDITION_OPERATORS = {
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'at_least', 'at_most'],
  text: ['equals', 'not_equals', 'contains', 'not_contains'],
  choice: ['equals', 'not_equals'],
  list: ['includes', 'excludes'],
  boolean: ['equals'],
} as const satisfies Record<FactType, readonly string[]>;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[FactType][number];
export const CONDITION_OPERATOR_NAMES: readonly ConditionOperator[] = [
  ...new Set(Object.values(CONDITION_OPERATORS).flat()),
];

export interface WorkflowCondition {
  field: string;
  operator: ConditionOperator;
  value: string;
}

/**
 * Why `condition` cannot be one of a workflow reading `fields`, if it cannot: a field it reads,
 * an operator its type has, and a value of its type.
 */
export function conditionProblem(
  fields: readonly FactField[],
  condition: WorkflowCondition,
): { on: 'field' | 'operator' | 'value'; message: string } | null {
  const field = fields.find((each) => each.key === condition.field);
  if (!field) return { on: 'field', message: "isn't something this trigger tells of" };
  if (!(CONDITION_OPERATORS[field.type] as readonly string[]).includes(condition.operator)) {
    return { on: 'operator', message: `can't compare ${field.type === 'list' ? 'a list' : 'it'}` };
  }
  const value = condition.value.trim();
  if (value.length > WORKFLOW_LIMITS.value) {
    return { on: 'value', message: `must be ${WORKFLOW_LIMITS.value} characters at most` };
  }
  switch (field.type) {
    case 'number':
      return value !== '' && Number.isFinite(Number(value))
        ? null
        : { on: 'value', message: 'must be a number' };
    case 'boolean':
      return value === 'true' || value === 'false'
        ? null
        : { on: 'value', message: 'must be true or false' };
    case 'choice':
      return field.options?.includes(value)
        ? null
        : { on: 'value', message: `must be one of ${field.options?.join(', ')}` };
    default:
      return value === '' ? { on: 'value', message: "can't be blank" } : null;
  }
}

/** Whether `condition` holds of `facts`. A fact not known holds only for "not" and "excludes". */
export function holds(condition: WorkflowCondition, facts: Facts): boolean {
  const fact = facts[condition.field];
  const value = condition.value.trim();
  const negative = ['not_equals', 'not_contains', 'excludes'].includes(condition.operator);
  if (fact === null || fact === undefined) return negative;
  if (typeof fact === 'number') {
    const wanted = Number(value);
    switch (condition.operator) {
      case 'equals':
        return fact === wanted;
      case 'not_equals':
        return fact !== wanted;
      case 'greater_than':
        return fact > wanted;
      case 'less_than':
        return fact < wanted;
      case 'at_least':
        return fact >= wanted;
      case 'at_most':
        return fact <= wanted;
      default:
        return false;
    }
  }
  if (typeof fact === 'boolean') return condition.operator === 'equals' && String(fact) === value;
  const wanted = value.toLowerCase();
  if (Array.isArray(fact)) {
    const has = fact.some((each) => each.toLowerCase() === wanted);
    return condition.operator === 'includes' ? has : condition.operator === 'excludes' && !has;
  }
  const text = fact.toLowerCase();
  switch (condition.operator) {
    case 'equals':
      return text === wanted;
    case 'not_equals':
      return text !== wanted;
    case 'contains':
      return text.includes(wanted);
    case 'not_contains':
      return !text.includes(wanted);
    default:
      return false;
  }
}

/** Whether a workflow's conditions hold: all of them, or any; one with none always runs. */
export function conditionsHold(
  match: 'all' | 'any',
  conditions: readonly WorkflowCondition[],
  facts: Facts,
): boolean {
  if (conditions.length === 0) return true;
  return match === 'all'
    ? conditions.every((each) => holds(each, facts))
    : conditions.some((each) => holds(each, facts));
}

/** Hatti's own actions, and what each needs the run to be about. */
export const WORKFLOW_ACTIONS = {
  add_order_tags: { needs: 'order' },
  remove_order_tags: { needs: 'order' },
  add_customer_tags: { needs: 'customer' },
  remove_customer_tags: { needs: 'customer' },
  // The order held for review, as for its risk, until staff confirm it (ADR-904).
  hold_order: { needs: 'order' },
  notify_staff: { needs: null },
  app_action: { needs: null },
  // The run waits, then goes on with the order or customer as they are then (ADR-886).
  wait: { needs: null },
  // The run goes on only where these hold then; else the rest is left (ADR-886).
  continue_if: { needs: null },
} as const satisfies Record<string, { needs: 'order' | 'customer' | null }>;

export type WorkflowActionType = keyof typeof WORKFLOW_ACTIONS;
export const WORKFLOW_ACTION_TYPES = Object.keys(WORKFLOW_ACTIONS) as WorkflowActionType[];

export type WorkflowAction =
  | {
      type: 'add_order_tags' | 'remove_order_tags' | 'add_customer_tags' | 'remove_customer_tags';
      tags: string[];
    }
  | { type: 'hold_order' }
  | { type: 'notify_staff'; title: string; message: string }
  | { type: 'app_action'; extensionId: string; properties: Record<string, string> }
  | { type: 'wait'; hours: number }
  | { type: 'continue_if'; match: 'all' | 'any'; conditions: WorkflowCondition[] };

/** What a run of a workflow on `trigger` is about, as far as its actions can tell. */
export function subjectsOf(
  trigger: WorkflowTrigger,
  resource: FlowResource | null,
): { order: boolean; customer: boolean } {
  const subject = trigger === 'app' ? (resource ?? 'none') : WORKFLOW_TRIGGERS[trigger].subject;
  return { order: subject === 'order', customer: subject === 'order' || subject === 'customer' };
}

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)+)\s*\}\}/g;

/** The fields a template's placeholders name: "{{order.number}}" names order.number. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** A template with its placeholders filled from `facts`: lists by commas, unknowns blank. */
export function render(template: string, facts: Facts): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    const fact = facts[key];
    if (fact === null || fact === undefined) return '';
    return Array.isArray(fact) ? fact.join(', ') : String(fact);
  });
}

/**
 * The tags an action leaves: `tags` with `add` added and `remove` taken away, ignoring case,
 * in their order, the new ones last.
 */
export function retagged(
  tags: readonly string[],
  change: { add?: readonly string[]; remove?: readonly string[] },
): string[] {
  const removed = new Set((change.remove ?? []).map((tag) => tag.toLowerCase()));
  const kept = tags.filter((tag) => !removed.has(tag.toLowerCase()));
  const seen = new Set(kept.map((tag) => tag.toLowerCase()));
  for (const tag of change.add ?? []) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    kept.push(tag);
  }
  return kept;
}

/** How one action of a run went. */
export interface WorkflowStep {
  action: WorkflowActionType;
  outcome: 'done' | 'failed' | 'skipped';
  detail: string | null;
}
