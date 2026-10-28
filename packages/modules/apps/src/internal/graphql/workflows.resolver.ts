import { CurrentTenant, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  WorkflowService,
  type FlowExtensionRecord,
  type WorkflowInput as WorkflowServiceInput,
  type WorkflowRecord,
  type WorkflowRunRecord,
} from '../workflows.service.js';
import type { FlowResource as FlowResourceValue, WorkflowAction } from '../workflows.js';
import {
  FlowExtension,
  FlowExtensionDeletePayload,
  FlowExtensionInput,
  FlowExtensionKind,
  FlowExtensionPayload,
  FlowPropertyInput,
  FlowTriggerReceivePayload,
  Workflow,
  WorkflowDeletePayload,
  WorkflowInput,
  WorkflowPayload,
  WorkflowRun,
  enumOf,
  keptOf,
} from './workflows.types.js';

const NOT_FOUND = 'No workflow of the shop has this ID';

export const toFlowExtension = (record: FlowExtensionRecord): FlowExtension =>
  Object.assign(new FlowExtension(), {
    ...record,
    id: toPublicId('flowExtension', record.id),
    appId: toPublicId('accessToken', record.appId),
    kind: enumOf(record.kind),
    resource: enumOf(record.resource),
    fields: record.fields.map((field) => ({ ...field, type: enumOf(field.type) })),
  });

const toAction = (action: WorkflowAction) => ({
  type: enumOf(action.type),
  tags: 'tags' in action ? action.tags : [],
  title: action.type === 'notify_staff' ? action.title : null,
  message: action.type === 'notify_staff' ? action.message : null,
  extensionId:
    action.type === 'app_action' ? toPublicId('flowExtension', action.extensionId) : null,
  properties:
    action.type === 'app_action'
      ? Object.entries(action.properties).map(([key, value]) => ({ key, value }))
      : [],
});

const toWorkflow = (record: WorkflowRecord): Workflow =>
  Object.assign(new Workflow(), {
    id: toPublicId('workflow', record.id),
    name: record.name,
    trigger: enumOf(record.trigger),
    extension: record.extension && toFlowExtension(record.extension),
    match: enumOf(record.match),
    conditions: record.conditions.map((each) => ({ ...each, operator: enumOf(each.operator) })),
    actions: record.actions.map(toAction),
    enabled: record.enabled,
    lastRunStatus: record.lastRun ? enumOf(record.lastRun.status) : null,
    lastRunAt: record.lastRun?.createdAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

const toRun = (record: WorkflowRunRecord): WorkflowRun =>
  Object.assign(new WorkflowRun(), {
    id: toPublicId('workflowRun', record.id),
    status: enumOf(record.status),
    orderId: record.orderId && toPublicId('order', record.orderId),
    customerId: record.customerId && toPublicId('customer', record.customerId),
    steps: record.steps.map((step) => ({
      action: enumOf(step.action),
      outcome: enumOf(step.outcome),
      detail: step.detail,
    })),
    attempts: record.attempts,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  });

/** The API's input as the service takes it: its enums kept, its IDs decoded (none for bad ones). */
function inputOf(input: WorkflowInput): WorkflowServiceInput {
  const decoded = (id: string | null | undefined) =>
    (id && tryFromPublicId(id, 'flowExtension')) || null;
  return {
    name: input.name,
    trigger: keptOf(input.trigger),
    extensionId: decoded(input.extensionId),
    match: input.match ? keptOf(input.match) : null,
    conditions: (input.conditions ?? []).map((each) => ({
      field: each.field,
      operator: keptOf(each.operator),
      value: each.value,
    })),
    actions: input.actions.map((action) => ({
      type: keptOf(action.type),
      tags: action.tags,
      title: action.title,
      message: action.message,
      extensionId: decoded(action.extensionId),
      properties: action.properties,
    })),
    enabled: input.enabled,
  };
}

const workflowPayload = (result: Awaited<ReturnType<WorkflowService['create']>>) =>
  Object.assign(new WorkflowPayload(), {
    workflow: result.ok ? toWorkflow(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });

/**
 * Workflows (DEV-11, ADR-861): the shop's own, made by the owner and managers; and the triggers
 * and actions apps offer them, which apps alone set, and whose triggers apps alone fire.
 */
@Resolver(() => Workflow)
export class WorkflowResolver {
  constructor(private readonly service: WorkflowService) {}

  @Query(() => [FlowExtension], {
    description:
      "The calling app's workflow triggers and actions; for the owner and managers, every app's.",
  })
  async flowExtensions(@CurrentTenant() tenant: TenantContext): Promise<FlowExtension[]> {
    return (await this.service.extensions(tenant)).map(toFlowExtension);
  }

  @Query(() => [Workflow], { description: "The shop's workflows: the owner's and managers'." })
  async workflows(@CurrentTenant() tenant: TenantContext): Promise<Workflow[]> {
    return (await this.service.list(tenant)).map(toWorkflow);
  }

  @Query(() => Workflow, { nullable: true })
  async workflow(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Workflow | null> {
    const uuid = tryFromPublicId(id, 'workflow');
    const record = uuid ? await this.service.get(tenant, uuid) : null;
    return record && toWorkflow(record);
  }

  @Query(() => [WorkflowRun], {
    description: "A workflow's runs of the last 30 days, the latest first (20, 100 at most).",
  })
  async workflowRuns(
    @CurrentTenant() tenant: TenantContext,
    @Args('workflowId', { type: () => ID }) workflowId: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
  ): Promise<WorkflowRun[]> {
    const uuid = tryFromPublicId(workflowId, 'workflow');
    const runs = uuid ? await this.service.runs(tenant, uuid, first ?? 20) : null;
    return (runs ?? []).map(toRun);
  }

  @Mutation(() => FlowExtensionPayload, {
    description:
      "Offers the calling app's workflow trigger or action, or changes it by its kind and handle. " +
      'One about orders needs the app to read them; about customers, to read customers.',
  })
  async flowExtensionSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: FlowExtensionInput,
  ): Promise<FlowExtensionPayload> {
    const result = await this.service.setExtension(tenant, {
      kind: keptOf(input.kind),
      handle: input.handle,
      title: input.title,
      description: input.description,
      resource: keptOf<FlowResourceValue>(input.resource),
      url: input.url,
      fields: (input.fields ?? []).map((field) => ({ ...field, type: keptOf(field.type) })),
    });
    return Object.assign(new FlowExtensionPayload(), {
      flowExtension: result.ok ? toFlowExtension(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FlowExtensionDeletePayload, {
    description: "Takes back the calling app's trigger or action: workflows stop using it.",
  })
  async flowExtensionDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('kind', { type: () => FlowExtensionKind }) kind: FlowExtensionKind,
    @Args('handle') handle: string,
  ): Promise<FlowExtensionDeletePayload> {
    const result = await this.service.removeExtension(tenant, keptOf(kind), handle);
    return Object.assign(new FlowExtensionDeletePayload(), {
      deletedFlowExtensionId: result.ok ? toPublicId('flowExtension', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FlowTriggerReceivePayload, {
    description:
      "Fires the calling app's trigger, as Shopify's flowTriggerReceive does: about the order or " +
      'customer its resource names, with its fields. Each enabled workflow on it runs once.',
  })
  async flowTriggerReceive(
    @CurrentTenant() tenant: TenantContext,
    @Args('handle') handle: string,
    @Args('orderId', { type: () => ID, nullable: true }) orderId?: string | null,
    @Args('customerId', { type: () => ID, nullable: true }) customerId?: string | null,
    @Args('properties', { type: () => [FlowPropertyInput], nullable: true })
    properties?: FlowPropertyInput[] | null,
  ): Promise<FlowTriggerReceivePayload> {
    const order = orderId ? tryFromPublicId(orderId, 'order') : null;
    const customer = customerId ? tryFromPublicId(customerId, 'customer') : null;
    const result =
      orderId && !order
        ? failOne(['orderId'], 'NOT_FOUND', 'No order has this ID')
        : customerId && !customer
          ? failOne(['customerId'], 'NOT_FOUND', 'No customer has this ID')
          : await this.service.receiveTrigger(tenant, handle, {
              orderId: order,
              customerId: customer,
              properties: properties ?? [],
            });
    return Object.assign(new FlowTriggerReceivePayload(), {
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => WorkflowPayload, { description: 'Makes a workflow: on unless asked otherwise.' })
  async workflowCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: WorkflowInput,
  ): Promise<WorkflowPayload> {
    return workflowPayload(await this.service.create(tenant, inputOf(input)));
  }

  @Mutation(() => WorkflowPayload, {
    description: 'Changes a workflow, all of it: runs from now on do as it now says.',
  })
  async workflowUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: WorkflowInput,
  ): Promise<WorkflowPayload> {
    const uuid = tryFromPublicId(id, 'workflow');
    return workflowPayload(
      uuid
        ? await this.service.update(tenant, uuid, inputOf(input))
        : failOne(['id'], 'NOT_FOUND', NOT_FOUND),
    );
  }

  @Mutation(() => WorkflowDeletePayload, { description: 'Deletes a workflow and its runs.' })
  async workflowDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<WorkflowDeletePayload> {
    const uuid = tryFromPublicId(id, 'workflow');
    const result = uuid
      ? await this.service.delete(tenant, uuid)
      : failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
    return Object.assign(new WorkflowDeletePayload(), {
      deletedWorkflowId: result.ok ? toPublicId('workflow', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
