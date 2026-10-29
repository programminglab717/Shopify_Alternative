import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum WorkflowTriggerType {
  ORDER_CREATED = 'ORDER_CREATED',
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  ORDER_PAID = 'ORDER_PAID',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_DELIVERED = 'ORDER_DELIVERED',
  ORDER_RETURNED = 'ORDER_RETURNED',
  CUSTOMER_CREATED = 'CUSTOMER_CREATED',
  STOCK_LOW = 'STOCK_LOW',
  STOCK_OUT = 'STOCK_OUT',
  SCHEDULED = 'SCHEDULED',
  APP = 'APP',
}

registerEnumType(WorkflowTriggerType, {
  name: 'WorkflowTriggerType',
  description:
    'What starts a workflow (DEV-11, ADR-861): an order placed, confirmed, paid or cancelled; ' +
    'its parcel delivered or returned; a customer created; STOCK_LOW and STOCK_OUT, a variant ' +
    "fallen to the shop's low-stock line or run out, once a spell as its alert is (ADR-905); " +
    "SCHEDULED, days of the week at an hour of the shop's own time, its queues then (ADR-906); " +
    'or APP, a trigger an app offers.',
});

export enum WorkflowMatch {
  ALL = 'ALL',
  ANY = 'ANY',
}

registerEnumType(WorkflowMatch, {
  name: 'WorkflowMatch',
  description: "Whether all a workflow's conditions must hold, or any of them.",
});

export enum WorkflowConditionOperator {
  EQUALS = 'EQUALS',
  NOT_EQUALS = 'NOT_EQUALS',
  GREATER_THAN = 'GREATER_THAN',
  LESS_THAN = 'LESS_THAN',
  AT_LEAST = 'AT_LEAST',
  AT_MOST = 'AT_MOST',
  CONTAINS = 'CONTAINS',
  NOT_CONTAINS = 'NOT_CONTAINS',
  INCLUDES = 'INCLUDES',
  EXCLUDES = 'EXCLUDES',
}

registerEnumType(WorkflowConditionOperator, {
  name: 'WorkflowConditionOperator',
  description:
    'How a condition compares: numbers by EQUALS to AT_MOST; words by EQUALS, NOT_EQUALS, ' +
    'CONTAINS and NOT_CONTAINS, ignoring case; lists, as tags, by INCLUDES and EXCLUDES.',
});

export enum WorkflowActionType {
  ADD_ORDER_TAGS = 'ADD_ORDER_TAGS',
  REMOVE_ORDER_TAGS = 'REMOVE_ORDER_TAGS',
  ADD_CUSTOMER_TAGS = 'ADD_CUSTOMER_TAGS',
  REMOVE_CUSTOMER_TAGS = 'REMOVE_CUSTOMER_TAGS',
  HOLD_ORDER = 'HOLD_ORDER',
  NOTIFY_STAFF = 'NOTIFY_STAFF',
  APP_ACTION = 'APP_ACTION',
  WAIT = 'WAIT',
  CONTINUE_IF = 'CONTINUE_IF',
}

registerEnumType(WorkflowActionType, {
  name: 'WorkflowActionType',
  description:
    'What a workflow does: tags added to or taken from the order or its customer; HOLD_ORDER, ' +
    "the order held for review until staff confirm it (ADR-904); the owner's " +
    "and managers' phones told; APP_ACTION, an action an app offers, posted to it signed; " +
    'WAIT, hours before the next action (ADR-886); or CONTINUE_IF, conditions checked of the ' +
    'order or customer as they are then, the rest left where they do not hold.',
});

export enum WorkflowRunStatus {
  PENDING = 'PENDING',
  DONE = 'DONE',
  SKIPPED = 'SKIPPED',
  FAILED = 'FAILED',
}

registerEnumType(WorkflowRunStatus, {
  name: 'WorkflowRunStatus',
  description:
    'PENDING until its actions are done, or an app answers; SKIPPED where its conditions did ' +
    "not hold; FAILED where an action could not be done, or an app's did not answer in a day.",
});

export enum WorkflowStepOutcome {
  DONE = 'DONE',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(WorkflowStepOutcome, { name: 'WorkflowStepOutcome' });

export enum FlowExtensionKind {
  TRIGGER = 'TRIGGER',
  ACTION = 'ACTION',
}

registerEnumType(FlowExtensionKind, {
  name: 'FlowExtensionKind',
  description: "A trigger an app fires for the shop's workflows, or an action it is sent.",
});

export enum FlowResource {
  ORDER = 'ORDER',
  CUSTOMER = 'CUSTOMER',
  NONE = 'NONE',
}

registerEnumType(FlowResource, {
  name: 'FlowResource',
  description:
    "What an app's trigger or action is about: an order, whose ID the app sends with the trigger " +
    'or is sent with the action, and needs read_orders for; a customer, read_customers; or none.',
});

export enum FlowFieldType {
  TEXT = 'TEXT',
  NUMBER = 'NUMBER',
  BOOLEAN = 'BOOLEAN',
}

registerEnumType(FlowFieldType, { name: 'FlowFieldType' });

/** An API enum's value as it is kept, and back: ORDER_CREATED is "order_created". */
export const keptOf = <T extends string>(value: string): T => value.toLowerCase() as T;
export const enumOf = <T extends string>(value: string): T => value.toUpperCase() as T;

@ObjectType({ description: "A field an app's trigger sends, or its action is sent." })
export class FlowField {
  @Field({ description: 'Lowercase letters, digits and underscores: "rating".' })
  key!: string;

  @Field()
  label!: string;

  @Field(() => FlowFieldType)
  type!: FlowFieldType;

  @Field()
  required!: boolean;
}

@ObjectType({
  description:
    "A trigger or an action an app offers the shop's workflows (DEV-11, ADR-861), as a Shopify " +
    'Flow extension is.',
})
export class FlowExtension {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The app offering it.' })
  appId!: string;

  @Field()
  appName!: string;

  @Field(() => FlowExtensionKind)
  kind!: FlowExtensionKind;

  @Field({ description: 'The app\'s own name for it: "review-posted".' })
  handle!: string;

  @Field()
  title!: string;

  @Field()
  description!: string;

  @Field(() => FlowResource)
  resource!: FlowResource;

  @Field(() => String, { nullable: true, description: 'Where an action is posted.' })
  url!: string | null;

  @Field(() => [FlowField])
  fields!: FlowField[];

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class FlowProperty {
  @Field()
  key!: string;

  @Field()
  value!: string;
}

@ObjectType()
export class WorkflowCondition {
  @Field({ description: 'What it reads: "order.total", "customer.tags", "trigger.rating".' })
  field!: string;

  @Field(() => WorkflowConditionOperator)
  operator!: WorkflowConditionOperator;

  @Field()
  value!: string;
}

@ObjectType({ description: 'An action of a workflow, with what its type takes.' })
export class WorkflowAction {
  @Field(() => WorkflowActionType)
  type!: WorkflowActionType;

  @Field(() => [String], { description: 'The tags added or taken away.' })
  tags!: string[];

  @Field(() => String, { nullable: true, description: "A push's title: {{order.number}} fills." })
  title!: string | null;

  @Field(() => String, { nullable: true })
  message!: string | null;

  @Field(() => ID, { nullable: true, description: "An app's action." })
  extensionId!: string | null;

  @Field(() => [FlowProperty])
  properties!: FlowProperty[];

  @Field(() => Int, { nullable: true, description: "A wait's hours, 1 to 168." })
  hours!: number | null;

  @Field(() => WorkflowMatch, {
    nullable: true,
    description: "A check's: whether all its conditions must hold, or any.",
  })
  match!: WorkflowMatch | null;

  @Field(() => [WorkflowCondition], { description: "A check's conditions; none for the rest." })
  conditions!: WorkflowCondition[];
}

@ObjectType({
  description:
    "When a scheduled workflow runs (ADR-906): days of the week at an hour of the shop's own " +
    "time, each slot once. Its run tells the shop's queues then: orders to confirm, review, " +
    'pack and book, and variants running low or out.',
})
export class WorkflowSchedule {
  @Field(() => [Int], { description: 'Monday 1 to Sunday 7.' })
  days!: number[];

  @Field(() => Int, { description: "0 to 23, of the shop's own time." })
  hour!: number;
}

@InputType()
export class WorkflowScheduleInput {
  @Field(() => [Int], { description: 'Monday 1 to Sunday 7.' })
  days!: number[];

  @Field(() => Int, { description: "0 to 23, of the shop's own time." })
  hour!: number;
}

@ObjectType({
  description:
    "The shop's own automation (DEV-11, ADR-861): a trigger, conditions on what it is about, " +
    'and actions done in turn.',
})
export class Workflow {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => WorkflowTriggerType)
  trigger!: WorkflowTriggerType;

  @Field(() => FlowExtension, {
    nullable: true,
    description: "An app's trigger; null for Hatti's own, and once the app took it back.",
  })
  extension!: FlowExtension | null;

  @Field(() => WorkflowMatch)
  match!: WorkflowMatch;

  @Field(() => [WorkflowCondition])
  conditions!: WorkflowCondition[];

  @Field(() => [WorkflowAction])
  actions!: WorkflowAction[];

  @Field()
  enabled!: boolean;

  @Field(() => WorkflowSchedule, {
    nullable: true,
    description: 'When a SCHEDULED workflow runs (ADR-906); null for the others.',
  })
  schedule!: WorkflowSchedule | null;

  @Field(() => WorkflowRunStatus, { nullable: true })
  lastRunStatus!: WorkflowRunStatus | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastRunAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class WorkflowStep {
  @Field(() => WorkflowActionType)
  action!: WorkflowActionType;

  @Field(() => WorkflowStepOutcome)
  outcome!: WorkflowStepOutcome;

  @Field(() => String, { nullable: true })
  detail!: string | null;
}

@ObjectType({ description: 'One run of a workflow, for one event: kept 30 days.' })
export class WorkflowRun {
  @Field(() => ID)
  id!: string;

  @Field(() => WorkflowRunStatus)
  status!: WorkflowRunStatus;

  @Field(() => ID, { nullable: true })
  orderId!: string | null;

  @Field(() => ID, { nullable: true })
  customerId!: string | null;

  @Field(() => [WorkflowStep])
  steps!: WorkflowStep[];

  @Field(() => Int)
  attempts!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  finishedAt!: Date | null;
}

@InputType()
export class FlowFieldInput {
  @Field()
  key!: string;

  @Field()
  label!: string;

  @Field(() => FlowFieldType)
  type!: FlowFieldType;

  @Field(() => Boolean, { nullable: true })
  required?: boolean | null;
}

@InputType()
export class FlowExtensionInput {
  @Field(() => FlowExtensionKind)
  kind!: FlowExtensionKind;

  @Field()
  handle!: string;

  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => FlowResource)
  resource!: FlowResource;

  @Field(() => String, { nullable: true, description: "An action's https address." })
  url?: string | null;

  @Field(() => [FlowFieldInput], { nullable: true })
  fields?: FlowFieldInput[] | null;
}

@InputType()
export class FlowPropertyInput {
  @Field()
  key!: string;

  @Field()
  value!: string;
}

@InputType()
export class WorkflowConditionInput {
  @Field()
  field!: string;

  @Field(() => WorkflowConditionOperator)
  operator!: WorkflowConditionOperator;

  @Field()
  value!: string;
}

@InputType()
export class WorkflowActionInput {
  @Field(() => WorkflowActionType)
  type!: WorkflowActionType;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  message?: string | null;

  @Field(() => ID, { nullable: true })
  extensionId?: string | null;

  @Field(() => Int, { nullable: true, description: "A wait's hours, 1 to 168." })
  hours?: number | null;

  @Field(() => WorkflowMatch, { nullable: true })
  match?: WorkflowMatch | null;

  @Field(() => [WorkflowConditionInput], { nullable: true, description: "A check's." })
  conditions?: WorkflowConditionInput[] | null;

  @Field(() => [FlowPropertyInput], { nullable: true })
  properties?: FlowPropertyInput[] | null;
}

@InputType()
export class WorkflowInput {
  @Field()
  name!: string;

  @Field(() => WorkflowTriggerType)
  trigger!: WorkflowTriggerType;

  @Field(() => ID, { nullable: true, description: "The app's trigger, for APP." })
  extensionId?: string | null;

  @Field(() => WorkflowMatch, { nullable: true })
  match?: WorkflowMatch | null;

  @Field(() => [WorkflowConditionInput], { nullable: true })
  conditions?: WorkflowConditionInput[] | null;

  @Field(() => [WorkflowActionInput])
  actions!: WorkflowActionInput[];

  @Field(() => Boolean, { nullable: true, description: 'On unless given.' })
  enabled?: boolean | null;

  @Field(() => WorkflowScheduleInput, {
    nullable: true,
    description: 'For a SCHEDULED workflow alone, which needs it.',
  })
  schedule?: WorkflowScheduleInput | null;
}

@ObjectType()
export class FlowExtensionPayload {
  @Field(() => FlowExtension, { nullable: true })
  flowExtension!: FlowExtension | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FlowExtensionDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedFlowExtensionId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FlowTriggerReceivePayload {
  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WorkflowPayload {
  @Field(() => Workflow, { nullable: true })
  workflow!: Workflow | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WorkflowDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedWorkflowId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
