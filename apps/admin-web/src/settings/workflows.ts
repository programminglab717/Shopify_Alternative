import type {
  FlowExtension,
  WorkflowAction,
  WorkflowActionType,
  WorkflowConditionOperator,
  WorkflowInput,
  WorkflowTriggerType,
} from '../api/types';
import type { MessageKey } from '../i18n/messages';

// What the shop's workflows may read and do (DEV-11, ADR-861), as the core checks them: the
// triggers, the facts each tells of, how each kind of fact compares, the actions, and workflows
// to start from.

export type FactType = 'number' | 'text' | 'choice' | 'list' | 'boolean';

export interface FactField {
  key: string;
  type: FactType;
  options?: readonly string[];
  /** An app's own label for its trigger's field; Hatti's are translated. */
  label?: string;
}

export const ORDER_FIELDS: readonly FactField[] = [
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
  { key: 'order.risk_level', type: 'choice', options: ['low', 'medium', 'high', 'none'] },
  { key: 'order.city', type: 'text' },
  { key: 'order.tags', type: 'list' },
  { key: 'order.discount_codes', type: 'list' },
  { key: 'order.skus', type: 'list' },
  { key: 'order.number', type: 'number' },
];

export const CUSTOMER_FIELDS: readonly FactField[] = [
  { key: 'customer.tags', type: 'list' },
  { key: 'customer.orders_count', type: 'number' },
  { key: 'customer.amount_spent', type: 'number' },
  { key: 'customer.returned_orders', type: 'number' },
  { key: 'customer.name', type: 'text' },
];

export const TRIGGERS: readonly WorkflowTriggerType[] = [
  'ORDER_CREATED',
  'ORDER_CONFIRMED',
  'ORDER_PAID',
  'ORDER_CANCELLED',
  'ORDER_DELIVERED',
  'ORDER_RETURNED',
  'CUSTOMER_CREATED',
  'APP',
];

export const OPERATORS: Record<FactType, readonly WorkflowConditionOperator[]> = {
  number: ['AT_LEAST', 'AT_MOST', 'GREATER_THAN', 'LESS_THAN', 'EQUALS', 'NOT_EQUALS'],
  text: ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS'],
  choice: ['EQUALS', 'NOT_EQUALS'],
  list: ['INCLUDES', 'EXCLUDES'],
  boolean: ['EQUALS'],
};

/** What a run of a workflow on `trigger` is about. */
export function subjectsOf(
  trigger: WorkflowTriggerType,
  extension: FlowExtension | null,
): { order: boolean; customer: boolean } {
  const order =
    trigger === 'APP' ? extension?.resource === 'ORDER' : trigger !== 'CUSTOMER_CREATED';
  return {
    order,
    customer: order || (trigger === 'APP' ? extension?.resource === 'CUSTOMER' : true),
  };
}

/** The facts a workflow on `trigger` reads. */
export function fieldsOf(
  trigger: WorkflowTriggerType,
  extension: FlowExtension | null,
): FactField[] {
  const has = subjectsOf(trigger, extension);
  return [
    ...(has.order ? ORDER_FIELDS : []),
    ...(has.customer ? CUSTOMER_FIELDS : []),
    ...(trigger === 'APP'
      ? (extension?.fields ?? []).map((field) => ({
          key: `trigger.${field.key}`,
          type: field.type.toLowerCase() as FactType,
          label: field.label,
        }))
      : []),
  ];
}

/** The actions a workflow on `trigger` can do, of Hatti's. */
export function actionsOf(trigger: WorkflowTriggerType, extension: FlowExtension | null) {
  const has = subjectsOf(trigger, extension);
  return [
    ...(has.order ? (['ADD_ORDER_TAGS', 'REMOVE_ORDER_TAGS'] as const) : []),
    ...(has.customer ? (['ADD_CUSTOMER_TAGS', 'REMOVE_CUSTOMER_TAGS'] as const) : []),
    'NOTIFY_STAFF',
  ] as WorkflowActionType[];
}

export const fieldLabel = (key: string): MessageKey =>
  `workflow.field.${key.replace('.', '_')}` as MessageKey;
export const valueLabel = (value: string): MessageKey => `workflow.value.${value}` as MessageKey;

export const blankAction = (type: WorkflowActionType): WorkflowAction => ({
  type,
  tags: [],
  title: type === 'NOTIFY_STAFF' ? '' : null,
  message: type === 'NOTIFY_STAFF' ? '' : null,
  extensionId: null,
  properties: [],
});

const notify = (title: string, message: string): WorkflowAction => ({
  ...blankAction('NOTIFY_STAFF'),
  title,
  message,
});

const tag = (type: WorkflowActionType, tags: string[]): WorkflowAction => ({
  ...blankAction(type),
  tags,
});

/** Workflows a shop in Pakistan starts from, each named in the merchant's words. */
export const TEMPLATES: readonly { id: string; label: MessageKey; workflow: WorkflowInput }[] = [
  {
    id: 'big-cod',
    label: 'workflow.template.bigCod',
    workflow: {
      name: 'Big cash-on-delivery orders',
      trigger: 'ORDER_CREATED',
      extensionId: null,
      match: 'ALL',
      conditions: [
        { field: 'order.payment_method', operator: 'EQUALS', value: 'cash_on_delivery' },
        { field: 'order.total', operator: 'AT_LEAST', value: '10000' },
      ],
      actions: [
        tag('ADD_ORDER_TAGS', ['big-cod']),
        notify('Big COD order {{order.name}}', 'Rs {{order.total}} to {{order.city}}: call first.'),
      ],
      enabled: true,
    },
  },
  {
    id: 'high-risk',
    label: 'workflow.template.highRisk',
    workflow: {
      name: 'High-risk orders',
      trigger: 'ORDER_CREATED',
      extensionId: null,
      match: 'ALL',
      conditions: [{ field: 'order.risk_level', operator: 'EQUALS', value: 'high' }],
      actions: [
        tag('ADD_ORDER_TAGS', ['high-risk']),
        notify('High-risk order {{order.name}}', 'Check it before it ships.'),
      ],
      enabled: true,
    },
  },
  {
    id: 'returns',
    label: 'workflow.template.returns',
    workflow: {
      name: 'Customers who return parcels',
      trigger: 'ORDER_RETURNED',
      extensionId: null,
      match: 'ALL',
      conditions: [{ field: 'customer.returned_orders', operator: 'AT_LEAST', value: '2' }],
      actions: [tag('ADD_CUSTOMER_TAGS', ['returns-often'])],
      enabled: true,
    },
  },
  {
    id: 'loyal',
    label: 'workflow.template.loyal',
    workflow: {
      name: 'Loyal customers',
      trigger: 'ORDER_DELIVERED',
      extensionId: null,
      match: 'ALL',
      conditions: [{ field: 'customer.orders_count', operator: 'AT_LEAST', value: '5' }],
      actions: [tag('ADD_CUSTOMER_TAGS', ['loyal'])],
      enabled: true,
    },
  },
];
