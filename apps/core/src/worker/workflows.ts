import type { TenantContext } from '@hatti/api';
import {
  WORKFLOW_EVENTS,
  WORKFLOW_LIMITS,
  conditionsHold,
  render,
  retagged,
  type DueWorkflowRun,
  type FactValue,
  type Facts,
  type WebhookSender,
  type WorkflowRunOutcome,
  type WorkflowService,
  type WorkflowStep,
} from '@hatti/apps/public';
import type { CustomerRecord, CustomerService } from '@hatti/customers/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import type { Logger } from '@hatti/logger';
import type { PushService } from '@hatti/messaging/public';
import { isCurrencyCode, money, toMajorString } from '@hatti/money';
import type { CustomerOrderStats, OrderRecord, OrderService } from '@hatti/orders/public';
import { recipientsIn } from './push-notices.js';
import { repeat } from './repeat.js';

/** The shop as the worker acts for it: only its ID is read. */
function workerTenant(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    scopes: new Set(),
  };
}

/**
 * Makes the runs of the shop's workflows its events trigger (DEV-11, ADR-861): one for each
 * enabled workflow on the trigger, once however often the event comes.
 */
export class WorkflowTriggers {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = WORKFLOW_EVENTS;

  constructor(private readonly workflows: Pick<WorkflowService, 'enqueue'>) {}

  async handle(event: DomainEvent): Promise<void> {
    await this.workflows.enqueue(event);
  }
}

/** What a sweep did. */
export interface WorkflowSweep {
  done: number;
  skipped: number;
  failed: number;
  /** An app's action to try again. */
  retrying: number;
  /** Runs waiting before their next action (ADR-886). */
  waiting: number;
}

/** Rupees as a condition reads them: 2499.5 for Rs 2,499.50. */
function rupees(minor: bigint, currency: string): number {
  return Number(toMajorString(money(minor, isCurrencyCode(currency) ? currency : 'PKR')));
}

/** What a workflow's conditions and templates read of an order. */
export function orderFacts(order: OrderRecord): Record<string, FactValue> {
  return {
    'order.number': order.number,
    'order.name': `#${order.number}`,
    'order.total': rupees(order.total, order.currency),
    'order.item_count': order.lines.reduce((sum, line) => sum + line.quantity, 0),
    'order.payment_method': order.paymentMethod,
    'order.source': order.source,
    'order.delivery_method': order.deliveryMethod,
    'order.stage': order.stage,
    'order.confirmation_status': order.confirmationStatus,
    'order.risk_level': order.risk?.level ?? 'none',
    'order.city': order.shippingAddress.city,
    'order.tags': order.tags,
    'order.discount_codes': order.discountCodes,
    'order.skus': order.lines.flatMap((line) => (line.sku ? [line.sku] : [])),
  };
}

/** What they read of a customer, with what they bought of the shop. */
export function customerFacts(
  customer: CustomerRecord,
  stats: CustomerOrderStats | undefined,
): Record<string, FactValue> {
  return {
    'customer.name': customer.name,
    'customer.tags': customer.tags,
    'customer.orders_count': stats?.count ?? 0,
    'customer.amount_spent': stats ? rupees(stats.amountSpent, 'PKR') : 0,
    'customer.returned_orders': stats?.returned ?? 0,
  };
}

/** What it is about, loaded: the order, its customer, and their facts. */
interface Loaded {
  order: OrderRecord | null;
  customer: CustomerRecord | null;
  facts: Facts;
}

/**
 * Runs the shop's workflows (DEV-11, ADR-861): each sweep takes up the runs due, checks each
 * one's conditions once, of the order or customer as they are then, and does its actions in
 * turn, each once. An app's action that did not answer is tried again, for a day, from it on;
 * one refused, or any other that could not be done, is recorded and the rest are done still.
 * A wait leaves the run until it is up, and it goes on from the next action with the order or
 * customer as they are then; a check leaves the rest where its conditions don't hold (ADR-886).
 */
export class WorkflowRuns {
  constructor(
    private readonly workflows: Pick<WorkflowService, 'claimDue' | 'finish' | 'postAppAction'>,
    private readonly orders: Pick<OrderService, 'getMany' | 'customerStats' | 'retag'>,
    private readonly customers: Pick<CustomerService, 'get' | 'update'>,
    private readonly database: Database,
    private readonly sender: WebhookSender,
    private readonly push: Pick<PushService, 'push' | 'publicKey'> | null = null,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`. */
  async sweep(at: Date = new Date()): Promise<WorkflowSweep> {
    const done: WorkflowSweep = { done: 0, skipped: 0, failed: 0, retrying: 0, waiting: 0 };
    for (const run of await this.workflows.claimDue(at)) {
      let outcome: WorkflowRunOutcome;
      try {
        outcome = await this.#run(run, at);
      } catch (error) {
        this.logger?.warn({ err: error, shopId: run.shopId, runId: run.id }, 'workflow run failed');
        // Tried again once its claim lapses, until its day is up.
        if (at.getTime() - run.since.getTime() < WORKFLOW_LIMITS.triesForMs) continue;
        outcome = { status: 'failed', conditionsMet: run.conditionsMet, steps: run.steps };
      }
      await this.workflows.finish(run, outcome, at);
      if (outcome.resumeAt) done.waiting += 1;
      else if (outcome.status === 'pending') done.retrying += 1;
      else done[outcome.status] += 1;
    }
    if (done.done + done.skipped + done.failed + done.retrying + done.waiting > 0) {
      this.logger?.info(done, 'workflows run');
    }
    return done;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'workflow runs sweep failed'),
    );
  }

  async #run(run: DueWorkflowRun, at: Date): Promise<WorkflowRunOutcome> {
    // Those done before a wait are kept; the next action is the one left out.
    const next = run.actions[run.steps.length]?.type ?? run.actions[0]?.type ?? 'notify_staff';
    const skipped = (detail: string): WorkflowRunOutcome => ({
      status: 'skipped',
      conditionsMet: run.conditionsMet,
      steps: [...run.steps, { action: next, outcome: 'skipped', detail }],
    });
    if (!run.enabled) return skipped('The workflow was turned off before it ran');
    const loaded = await this.#load(run);
    if (!loaded) return skipped("What the trigger told of isn't the shop's any more");
    const met = run.conditionsMet ?? conditionsHold(run.match, run.conditions, loaded.facts);
    if (!met) return { status: 'skipped', conditionsMet: false, steps: [] };

    // A run tried again goes on from the app's action that did not answer; one that waited,
    // from the action after its wait.
    const last = run.steps.at(-1);
    const again = last?.action === 'app_action' && last.outcome === 'failed';
    const steps: WorkflowStep[] = again ? run.steps.slice(0, -1) : [...run.steps];
    for (let index = steps.length; index < run.actions.length; index += 1) {
      const action = run.actions[index]!;
      if (action.type === 'wait') {
        const resumeAt = new Date(at.getTime() + action.hours * 3_600_000);
        steps.push({ action: 'wait', outcome: 'done', detail: `Until ${resumeAt.toISOString()}` });
        return { status: 'pending', conditionsMet: true, steps, resumeAt };
      }
      if (action.type === 'continue_if') {
        if (conditionsHold(action.match, action.conditions, loaded.facts)) {
          steps.push({ action: 'continue_if', outcome: 'done', detail: null });
          continue;
        }
        steps.push({
          action: 'continue_if',
          outcome: 'skipped',
          detail: "Its conditions didn't hold: the rest was left",
        });
        break;
      }
      const step = await this.#act(run, index, loaded, at);
      steps.push({ action: action.type, ...step });
      if (step.retry) return { status: 'pending', conditionsMet: true, steps: plain(steps) };
    }
    return {
      status: steps.some((step) => step.outcome === 'failed') ? 'failed' : 'done',
      conditionsMet: true,
      steps: plain(steps),
    };
  }

  /** The order or customer the run is about, and their facts; null for one no longer here. */
  async #load(run: DueWorkflowRun): Promise<Loaded | null> {
    const tenant = workerTenant(run.shopId);
    const { orderId, customerId, properties } = run.subject;
    let order: OrderRecord | null = null;
    if (orderId) {
      order = (await this.orders.getMany(tenant, [orderId])).get(orderId) ?? null;
      if (!order) return null;
    }
    const customerOf = order && !order.customerErasedAt ? order.customerId : customerId;
    const customer = customerOf ? await this.customers.get(tenant, customerOf) : null;
    if (customerId && !customer) return null;
    const stats = customer
      ? (await this.orders.customerStats(tenant, [customer.id])).get(customer.id)
      : undefined;
    const trigger: Record<string, FactValue> = {};
    for (const field of run.fields) {
      const value = properties[field.key];
      trigger[`trigger.${field.key}`] =
        value === undefined
          ? null
          : field.type === 'number'
            ? Number(value)
            : field.type === 'boolean'
              ? value === 'true'
              : value;
    }
    return {
      order,
      customer,
      facts: {
        ...(order && orderFacts(order)),
        ...(customer && customerFacts(customer, stats)),
        ...trigger,
      },
    };
  }

  /** One action of the run: how it went, and whether to try it again later. */
  async #act(
    run: DueWorkflowRun,
    index: number,
    { order, customer, facts }: Loaded,
    at: Date,
  ): Promise<Omit<WorkflowStep, 'action'> & { retry?: boolean }> {
    const action = run.actions[index]!;
    const tenant = workerTenant(run.shopId);
    switch (action.type) {
      case 'add_order_tags':
      case 'remove_order_tags': {
        if (!order) return { outcome: 'failed', detail: 'The trigger tells of no order' };
        const change =
          action.type === 'add_order_tags' ? { add: action.tags } : { remove: action.tags };
        const result = await this.orders.retag(run.shopId, order.id, change, run.workflowName);
        if (!result.ok) return { outcome: 'failed', detail: result.errors[0]!.message };
        return { outcome: 'done', detail: action.tags.join(', ') };
      }
      case 'add_customer_tags':
      case 'remove_customer_tags': {
        if (!customer) return { outcome: 'failed', detail: 'The trigger tells of no customer' };
        const current = await this.customers.get(tenant, customer.id);
        if (!current)
          return { outcome: 'failed', detail: "The customer isn't the shop's any more" };
        const tags = retagged(
          current.tags,
          action.type === 'add_customer_tags' ? { add: action.tags } : { remove: action.tags },
        );
        const result = await this.customers.update(tenant, customer.id, { tags });
        if (!result.ok) return { outcome: 'failed', detail: result.errors[0]!.message };
        return { outcome: 'done', detail: action.tags.join(', ') };
      }
      case 'notify_staff': {
        const push = this.push;
        if (!push?.publicKey) {
          return { outcome: 'skipped', detail: 'This server sends no pushes: it has no keys' };
        }
        const shop = toPublicId('shop', run.shopId);
        const url = order
          ? `/${shop}/orders/${toPublicId('order', order.id)}`
          : customer
            ? `/${shop}/customers/${toPublicId('customer', customer.id)}`
            : `/${shop}/settings/workflows/${toPublicId('workflow', run.workflowId)}`;
        const words = { title: render(action.title, facts), body: render(action.message, facts) };
        const recipients = await this.database.tenant(run.shopId, (tx) =>
          recipientsIn(tx, run.shopId),
        );
        const told = await push.push(
          run.shopId,
          'workflow_alert',
          `workflow:${run.id}:${index}`,
          recipients,
          { en: words, ur: words, url },
        );
        return { outcome: 'done', detail: `${told} ${told === 1 ? 'browser' : 'browsers'}` };
      }
      case 'wait':
      case 'continue_if':
        // Done by the run itself, in turn.
        return { outcome: 'done', detail: null };
      case 'app_action': {
        const properties = Object.fromEntries(
          Object.entries(action.properties).map(([key, value]) => [key, render(value, facts)]),
        );
        const sent = await this.workflows.postAppAction(
          this.sender,
          run,
          action.extensionId,
          properties,
          at,
        );
        if (sent.error === null) return { outcome: 'done', detail: null };
        const dayUp = at.getTime() - run.since.getTime() >= WORKFLOW_LIMITS.triesForMs;
        return {
          outcome: 'failed',
          detail: sent.error.slice(0, 300),
          ...(!sent.final && !dayUp && { retry: true }),
        };
      }
    }
  }
}

/** Steps as they are kept, without whether to try again. */
function plain(steps: (WorkflowStep & { retry?: boolean })[]): WorkflowStep[] {
  return steps.map(({ action, outcome, detail }) => ({ action, outcome, detail }));
}
