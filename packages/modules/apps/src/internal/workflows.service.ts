import { createHash } from 'node:crypto';
import {
  InputChecker,
  actorColumnsOf,
  deniedToRole,
  fail,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit, type DomainEvent } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { sealedFor } from './apps.js';
import type { WebhookSender } from './webhook-sender.js';
import { retryDelayMs, signWebhook, uriProblem } from './webhooks.js';
import {
  FLOW_RESOURCES,
  FlowEvents,
  WORKFLOW_ACTIONS,
  WORKFLOW_LIMITS,
  conditionProblem,
  TRIGGER_FIELDS,
  dueSlot,
  fieldsOf,
  isWorkflowTrigger,
  placeholdersOf,
  subjectsOf,
  triggersOf,
  type ConditionOperator,
  type FlowField,
  type FlowResource,
  type FlowTriggerReceivedPayload,
  type WorkflowAction,
  type WorkflowActionType,
  type WorkflowCondition,
  type WorkflowStep,
  type WorkflowSubject,
  type WorkflowSchedule,
  type WorkflowTrigger,
} from './workflows.js';

// Workflows (DEV-11, ADR-861): the shop's own automations, made by the owner and managers, and
// what apps offer them. An app offers triggers, which it fires with what they are about, and
// actions, which are posted to it signed with its secret, as its webhooks are. Each event the
// worker hears makes a run of each workflow it triggers, once however often it is heard; the
// worker's sweep checks a run's conditions once, then does its actions in turn, trying an app's
// again for a day where it did not answer. Runs are kept 30 days.

export interface FlowExtensionRecord {
  id: string;
  /** The app offering it: its access token's ID. */
  appId: string;
  appName: string;
  kind: 'trigger' | 'action';
  handle: string;
  title: string;
  description: string;
  resource: FlowResource;
  /** Where an action is posted; null for a trigger. */
  url: string | null;
  fields: FlowField[];
  updatedAt: Date;
}

export interface FlowExtensionInput {
  kind: 'trigger' | 'action';
  handle: string;
  title: string;
  description?: string | null;
  resource: FlowResource;
  url?: string | null;
  fields?: { key: string; label: string; type: string; required?: boolean | null }[] | null;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  /** An app's trigger; null for Hatti's own, and once the app took it back. */
  extension: FlowExtensionRecord | null;
  match: 'all' | 'any';
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
  /** When it runs, for a scheduled workflow (ADR-906); null for the others. */
  schedule: WorkflowSchedule | null;
  lastRun: { status: WorkflowRunStatus; createdAt: Date } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowActionInput {
  type: string;
  tags?: string[] | null;
  title?: string | null;
  message?: string | null;
  extensionId?: string | null;
  properties?: { key: string; value: string }[] | null;
  /** A wait's hours. */
  hours?: number | null;
  /** A check's conditions, and whether all must hold or any. */
  match?: 'all' | 'any' | null;
  conditions?: { field: string; operator: string; value: string }[] | null;
}

export interface WorkflowInput {
  name: string;
  trigger: string;
  extensionId?: string | null;
  match?: 'all' | 'any' | null;
  conditions?: { field: string; operator: string; value: string }[] | null;
  actions: WorkflowActionInput[];
  enabled?: boolean | null;
  /** For a scheduled workflow alone (ADR-906): its days, Monday 1, and hour, 0 to 23. */
  schedule?: { days: number[]; hour: number } | null;
}

export type WorkflowRunStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  orderId: string | null;
  customerId: string | null;
  steps: WorkflowStep[];
  attempts: number;
  createdAt: Date;
  finishedAt: Date | null;
}

/** A run the sweep took up, with its workflow as it is now. */
export interface DueWorkflowRun {
  shopId: string;
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: WorkflowTrigger;
  /** The resource of its app's trigger; null for Hatti's own, or one taken back. */
  resource: FlowResource | null;
  /** What its app's trigger sends; none for Hatti's own. */
  fields: FlowField[];
  enabled: boolean;
  match: 'all' | 'any';
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  subject: WorkflowSubject;
  conditionsMet: boolean | null;
  steps: WorkflowStep[];
  attempts: number;
  createdAt: Date;
  /** When it was made, or its last wait was up: an app's action is tried for a day from it. */
  since: Date;
}

/** What became of a run's try. */
export interface WorkflowRunOutcome {
  status: WorkflowRunStatus;
  conditionsMet: boolean | null;
  steps: WorkflowStep[];
  /** For a run waiting (ADR-886): when it goes on. */
  resumeAt?: Date;
}

type ExtensionRow = {
  id: string;
  token_id: string;
  app_name: string;
  kind: 'trigger' | 'action';
  handle: string;
  title: string;
  description: string;
  resource: FlowResource;
  url: string | null;
  fields: FlowField[];
  updated_at: Date | string;
};

const toExtension = (row: ExtensionRow): FlowExtensionRecord => ({
  id: row.id,
  appId: row.token_id,
  appName: row.app_name,
  kind: row.kind,
  handle: row.handle,
  title: row.title,
  description: row.description,
  resource: row.resource,
  url: row.url,
  fields: row.fields,
  updatedAt: toDate(row.updated_at),
});

type WorkflowRow = {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  extension_id: string | null;
  match: 'all' | 'any';
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
  schedule: WorkflowSchedule | null;
  last_run: { status: WorkflowRunStatus; created_at: string } | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RunRow = {
  id: string;
  workflow_id: string;
  status: WorkflowRunStatus;
  subject: WorkflowSubject;
  steps: WorkflowStep[];
  attempts: number;
  created_at: Date | string;
  finished_at: Date | string | null;
};

const toRun = (row: RunRow): WorkflowRunRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  status: row.status,
  orderId: row.subject.orderId,
  customerId: row.subject.customerId,
  steps: row.steps,
  attempts: row.attempts,
  createdAt: toDate(row.created_at),
  finishedAt: row.finished_at === null ? null : toDate(row.finished_at),
});

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const FIELD_TYPES: readonly FlowField['type'][] = ['text', 'number', 'boolean'];
const NOT_FOUND = 'No workflow of the shop has this ID';

/** Of the shop's apps' triggers and actions, those of apps it still has. */
const LIVE = sql`JOIN apps.access_tokens t ON t.shop_id = e.shop_id AND t.id = e.token_id
                  AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`;

const EXTENSION_COLUMNS = sql`e.id, e.token_id, t.name AS app_name, e.kind, e.handle, e.title,
  e.description, e.resource, e.url, e.fields, e.updated_at`;

/** The app calling, by its token: staff are refused, as an app offers its own. */
function callingApp(tenant: TenantContext): string {
  if (tenant.actor.kind !== 'app') {
    throw deniedToRole("Access denied. Apps offer their own workflows' triggers and actions.");
  }
  return tenant.actor.tokenId;
}

/** The owner and managers, and custom roles that keep it (ADR-578), make workflows. */
function workflowStaff(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || !hasCapability(tenant.actor, 'manage_apps')) {
    throw deniedToRole('Access denied. The owner and managers make workflows.');
  }
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  // ── What apps offer ────────────────────────────────────────────────────────────────────────

  /** The calling app's triggers and actions; for the owner and managers, every app's. */
  async extensions(tenant: TenantContext): Promise<FlowExtensionRecord[]> {
    const own = tenant.actor.kind === 'app' ? tenant.actor.tokenId : null;
    if (!own) workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, (tx) =>
      extensionsIn(tx, tenant.shopId, own ? sql`e.token_id = ${own}` : sql`true`),
    );
  }

  /**
   * Offers the calling app's trigger or action `handle`, or changes it. One about orders or
   * customers needs the app to read them, as it is sent their IDs.
   */
  async setExtension(
    tenant: TenantContext,
    input: FlowExtensionInput,
  ): Promise<MutationResult<FlowExtensionRecord>> {
    const tokenId = callingApp(tenant);
    const check = new InputChecker();
    const handle = input.handle.trim();
    if (!HANDLE.test(handle) || handle.length > WORKFLOW_LIMITS.handle) {
      check.addMessage(['input', 'handle'], 'INVALID', 'Use lowercase letters, digits and dashes');
    }
    const title = check.text(['input', 'title'], input.title, {
      required: true,
      max: WORKFLOW_LIMITS.title,
    });
    const description =
      check.text(['input', 'description'], input.description, {
        max: WORKFLOW_LIMITS.description,
      }) ?? '';
    if (!(FLOW_RESOURCES as readonly string[]).includes(input.resource)) {
      check.add(['input', 'resource'], 'INVALID', 'must be order, customer or none');
    }
    let url: string | null = null;
    if (input.kind === 'action') {
      url = check.text(['input', 'url'], input.url, { required: true, max: WORKFLOW_LIMITS.url });
      const problem = url && uriProblem(url);
      if (problem) check.add(['input', 'url'], 'INVALID', problem);
    } else if (input.url) {
      check.addMessage(['input', 'url'], 'INVALID', 'A trigger is sent by the app: it has no URL');
    }
    const fields = checkFields(check, input.fields ?? []);
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: apps } = await tx.execute<{ scopes: string[] }>(sql`
        SELECT scopes FROM apps.access_tokens WHERE shop_id = ${tenant.shopId} AND id = ${tokenId}`);
      const scopes = apps[0]?.scopes ?? [];
      const reads = input.resource === 'none' ? null : `${input.resource}s`;
      if (reads && !scopes.includes(`read_${reads}`) && !scopes.includes(`write_${reads}`)) {
        return failOne<FlowExtensionRecord>(
          ['input', 'resource'],
          'INVALID',
          `The app can't read ${reads}: give it the read_${reads} scope first`,
        );
      }
      const { rows: counted } = await tx.execute<{ count: number; mine: boolean }>(sql`
        SELECT count(*)::int AS count,
               coalesce(bool_or(kind = ${input.kind} AND handle = ${handle}), false) AS mine
          FROM apps.flow_extensions WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId}`);
      if (!counted[0]!.mine && counted[0]!.count >= WORKFLOW_LIMITS.extensionsPerApp) {
        return failOne<FlowExtensionRecord>(
          ['input', 'handle'],
          'TOO_MANY',
          `An app offers ${WORKFLOW_LIMITS.extensionsPerApp} triggers and actions at most`,
        );
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO apps.flow_extensions
               (shop_id, token_id, kind, handle, title, description, resource, url, fields)
        VALUES (${tenant.shopId}, ${tokenId}, ${input.kind}, ${handle}, ${title!}, ${description},
                ${input.resource}, ${url}, ${JSON.stringify(fields)}::jsonb)
        ON CONFLICT (shop_id, token_id, kind, handle) DO UPDATE
           SET title = EXCLUDED.title, description = EXCLUDED.description,
               resource = EXCLUDED.resource, url = EXCLUDED.url, fields = EXCLUDED.fields,
               updated_at = now()
        RETURNING id`);
      const [record] = await extensionsIn(tx, tenant.shopId, sql`e.id = ${rows[0]!.id}`);
      return { ok: true, value: record! };
    });
  }

  /** Takes back the calling app's trigger or action: workflows using it stop doing so. */
  async removeExtension(
    tenant: TenantContext,
    kind: 'trigger' | 'action',
    handle: string,
  ): Promise<MutationResult<string>> {
    const tokenId = callingApp(tenant);
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ id: string }>(sql`
        DELETE FROM apps.flow_extensions
         WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId} AND kind = ${kind}
           AND handle = ${handle}
        RETURNING id`),
    );
    if (!rows[0]) return failOne(['handle'], 'NOT_FOUND', `The app offers no such ${kind}`);
    return { ok: true, value: rows[0].id };
  }

  /**
   * Fires the calling app's trigger `handle`, about the order or customer its resource names,
   * with what its fields say: each enabled workflow on it runs once.
   */
  async receiveTrigger(
    tenant: TenantContext,
    handle: string,
    sent: {
      orderId: string | null;
      customerId: string | null;
      properties: { key: string; value: string }[];
    },
  ): Promise<MutationResult<string>> {
    const tokenId = callingApp(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [extension] = await extensionsIn(
        tx,
        tenant.shopId,
        sql`e.token_id = ${tokenId} AND e.kind = 'trigger' AND e.handle = ${handle}`,
      );
      if (!extension) {
        return failOne<string>(['handle'], 'NOT_FOUND', 'The app offers no such trigger');
      }
      const check = new InputChecker();
      if (extension.resource === 'order' && !sent.orderId) {
        check.addMessage(['orderId'], 'BLANK', 'Name the order this trigger is about');
      }
      if (extension.resource === 'customer' && !sent.customerId) {
        check.addMessage(['customerId'], 'BLANK', 'Name the customer this trigger is about');
      }
      const properties = checkProperties(check, extension.fields, sent.properties, 'literal');
      if (!check.ok) return fail<string>(check.errors);
      await appendEvent<FlowTriggerReceivedPayload>(tx, tenant.shopId, {
        type: FlowEvents.TriggerReceived,
        aggregateType: 'flow_extension',
        aggregateId: extension.id,
        payload: {
          orderId: extension.resource === 'order' ? sent.orderId : null,
          customerId: extension.resource === 'customer' ? sent.customerId : null,
          properties,
        },
      });
      return { ok: true, value: extension.id };
    });
  }

  // ── The shop's workflows ───────────────────────────────────────────────────────────────────

  async list(tenant: TenantContext): Promise<WorkflowRecord[]> {
    workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, (tx) => this.#workflows(tx, tenant.shopId, sql`true`));
  }

  async get(tenant: TenantContext, id: string): Promise<WorkflowRecord | null> {
    workflowStaff(tenant);
    return this.db.tenant(
      tenant.shopId,
      async (tx) => (await this.#workflows(tx, tenant.shopId, sql`w.id = ${id}`))[0] ?? null,
    );
  }

  async create(
    tenant: TenantContext,
    input: WorkflowInput,
  ): Promise<MutationResult<WorkflowRecord>> {
    workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const checked = await checkWorkflow(tx, tenant.shopId, input);
      if (!checked.ok) return checked;
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM apps.workflows WHERE shop_id = ${tenant.shopId}`);
      if (counted[0]!.count >= WORKFLOW_LIMITS.perShop) {
        return failOne<WorkflowRecord>(
          ['input', 'name'],
          'TOO_MANY',
          `A shop keeps ${WORKFLOW_LIMITS.perShop} workflows at most: delete one first`,
        );
      }
      const value = checked.value;
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO apps.workflows
               (shop_id, name, trigger, extension_id, match, conditions, actions, enabled,
                schedule)
        VALUES (${tenant.shopId}, ${value.name}, ${value.trigger}, ${value.extensionId},
                ${value.match}, ${JSON.stringify(value.conditions)}::jsonb,
                ${JSON.stringify(value.actions)}::jsonb, ${value.enabled},
                ${value.schedule && JSON.stringify(value.schedule)}::jsonb)
        RETURNING id`);
      return this.#saved(tx, tenant, rows[0]!.id, 'workflow.created');
    });
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: WorkflowInput,
  ): Promise<MutationResult<WorkflowRecord>> {
    workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const checked = await checkWorkflow(tx, tenant.shopId, input);
      if (!checked.ok) return checked;
      const value = checked.value;
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE apps.workflows
           SET name = ${value.name}, trigger = ${value.trigger},
               extension_id = ${value.extensionId}, match = ${value.match},
               conditions = ${JSON.stringify(value.conditions)}::jsonb,
               actions = ${JSON.stringify(value.actions)}::jsonb, enabled = ${value.enabled},
               schedule = ${value.schedule && JSON.stringify(value.schedule)}::jsonb,
               updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`);
      if (!rows[0]) return failOne<WorkflowRecord>(['id'], 'NOT_FOUND', NOT_FOUND);
      return this.#saved(tx, tenant, id, 'workflow.updated');
    });
  }

  /** Deletes a workflow and its runs: those not yet done are not. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string; name: string }>(sql`
        DELETE FROM apps.workflows WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id, name`);
      if (!rows[0]) return failOne<string>(['id'], 'NOT_FOUND', NOT_FOUND);
      await recordAudit(tx, tenant.shopId, {
        action: 'workflow.deleted',
        subjectType: 'workflow',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
        details: { name: rows[0].name },
      });
      return { ok: true, value: id };
    });
  }

  /** A workflow's runs of the last 30 days, the latest first; null for none of the shop's. */
  async runs(
    tenant: TenantContext,
    workflowId: string,
    first = 20,
  ): Promise<WorkflowRunRecord[] | null> {
    workflowStaff(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: found } = await tx.execute(sql`
        SELECT 1 FROM apps.workflows WHERE shop_id = ${tenant.shopId} AND id = ${workflowId}`);
      if (found.length === 0) return null;
      const { rows } = await tx.execute<RunRow>(sql`
        SELECT id, workflow_id, status, subject, steps, attempts, created_at, finished_at
          FROM apps.workflow_runs
         WHERE shop_id = ${tenant.shopId} AND workflow_id = ${workflowId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${Math.min(Math.max(first, 1), 100)}`);
      return rows.map(toRun);
    });
  }

  // ── Runs, for the worker ───────────────────────────────────────────────────────────────────

  /**
   * Makes a run of each enabled workflow `event` triggers, once however often it is heard, and
   * none of a workflow run {@link WORKFLOW_LIMITS.runsPerHour} times in the last hour. How many.
   */
  async enqueue(event: DomainEvent): Promise<number> {
    let made = 0;
    for (const { trigger, extensionId, subject } of triggersOf(event)) {
      const { rows } = await this.db.tenant(event.shopId, (tx) =>
        tx.execute<{ id: string }>(sql`
          INSERT INTO apps.workflow_runs (shop_id, workflow_id, event_id, subject)
          SELECT w.shop_id, w.id, ${event.id}, ${JSON.stringify(subject)}::jsonb
            FROM apps.workflows w
           WHERE w.shop_id = ${event.shopId} AND w.enabled AND w.trigger = ${trigger}
             ${extensionId ? sql`AND w.extension_id = ${extensionId}` : sql``}
             AND (SELECT count(*) FROM apps.workflow_runs r
                   WHERE r.shop_id = w.shop_id AND r.workflow_id = w.id
                     AND r.created_at > now() - interval '1 hour') < ${WORKFLOW_LIMITS.runsPerHour}
          ON CONFLICT (shop_id, workflow_id, event_id) DO NOTHING
          RETURNING id`),
      );
      made += rows.length;
    }
    return made;
  }

  /**
   * The scheduled workflows due a run at `at`, across shops (ADR-906): enabled ones whose day and
   * hour of the shop's own time have come, no more than two hours since, and not yet run for that
   * slot. Each with the slot's own event, the workflow and its slot by name.
   */
  async scheduledDue(
    at: Date = new Date(),
  ): Promise<{ shopId: string; workflowId: string; eventId: string; slot: Date }[]> {
    return this.db.system(async (tx) => {
      const { rows } = await tx.execute<{
        shop_id: string;
        id: string;
        schedule: WorkflowSchedule;
        timezone: string;
      }>(sql`
        SELECT w.shop_id, w.id, w.schedule, s.timezone
          FROM apps.workflows w JOIN control.shops s ON s.id = w.shop_id
         WHERE w.enabled AND w.trigger = 'scheduled' AND w.schedule IS NOT NULL`);
      const due = rows.flatMap((row) => {
        const slot = dueSlot(row.schedule, row.timezone, at);
        return slot
          ? [{ shopId: row.shop_id, workflowId: row.id, eventId: slotEventId(row.id, slot), slot }]
          : [];
      });
      if (due.length === 0) return [];
      const { rows: ran } = await tx.execute<{ event_id: string }>(sql`
        SELECT event_id FROM apps.workflow_runs
         WHERE event_id = ANY (${sql.param(due.map((each) => each.eventId))}::uuid[])`);
      const done = new Set(ran.map((row) => row.event_id));
      return due.filter((each) => !done.has(each.eventId));
    });
  }

  /**
   * A scheduled workflow's run for its slot (ADR-906), due from the slot, with the shop's queues
   * then as what its trigger tells: once a slot, however often it is asked. Whether it was made.
   */
  async enqueueScheduled(
    shopId: string,
    workflowId: string,
    eventId: string,
    slot: Date,
    properties: Record<string, string>,
  ): Promise<boolean> {
    const subject: WorkflowSubject = { orderId: null, customerId: null, properties };
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO apps.workflow_runs (shop_id, workflow_id, event_id, subject, next_attempt_at)
        SELECT w.shop_id, w.id, ${eventId}, ${JSON.stringify(subject)}::jsonb, ${slot}
          FROM apps.workflows w
         WHERE w.shop_id = ${shopId} AND w.id = ${workflowId} AND w.enabled
           AND w.trigger = 'scheduled'
        ON CONFLICT (shop_id, workflow_id, event_id) DO NOTHING
        RETURNING id`),
    );
    return rows.length > 0;
  }

  /**
   * Takes up the runs due at `at`, across shops, up to {@link WORKFLOW_LIMITS.batch}, each for a
   * while, so two sweeps never run the same one; forgets runs older than 30 days.
   */
  async claimDue(at: Date = new Date()): Promise<DueWorkflowRun[]> {
    return this.db.system(async (tx) => {
      await tx.execute(sql`
        DELETE FROM apps.workflow_runs
         WHERE created_at < ${new Date(at.getTime() - WORKFLOW_LIMITS.keptDays * 86_400_000)}
           AND status <> 'pending'`);
      const { rows } = await tx.execute<{
        shop_id: string;
        id: string;
        workflow_id: string;
        name: string;
        trigger: WorkflowTrigger;
        resource: FlowResource | null;
        fields: FlowField[] | null;
        enabled: boolean;
        match: 'all' | 'any';
        conditions: WorkflowCondition[];
        actions: WorkflowAction[];
        subject: WorkflowSubject;
        conditions_met: boolean | null;
        steps: WorkflowStep[];
        attempts: number;
        created_at: Date | string;
        waited_until: Date | string | null;
      }>(sql`
        WITH due AS (
          SELECT shop_id, id FROM apps.workflow_runs
           WHERE status = 'pending' AND next_attempt_at <= ${at}
           ORDER BY next_attempt_at
           LIMIT ${WORKFLOW_LIMITS.batch}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE apps.workflow_runs r
           SET attempts = r.attempts + 1,
               next_attempt_at = ${new Date(at.getTime() + 5 * 60_000)}
          FROM due, apps.workflows w
          LEFT JOIN apps.flow_extensions e
                 ON e.shop_id = w.shop_id AND e.id = w.extension_id
         WHERE r.shop_id = due.shop_id AND r.id = due.id
           AND w.shop_id = r.shop_id AND w.id = r.workflow_id
        RETURNING r.shop_id, r.id, r.workflow_id, w.name, w.trigger, e.resource, e.fields,
                  w.enabled, w.match, w.conditions, w.actions, r.subject, r.conditions_met,
                  r.steps, r.attempts, r.created_at, r.waited_until`);
      return rows.map((row) => ({
        shopId: row.shop_id,
        id: row.id,
        workflowId: row.workflow_id,
        workflowName: row.name,
        trigger: row.trigger,
        resource: row.resource,
        fields: row.fields ?? [...(TRIGGER_FIELDS[row.trigger as WorkflowTrigger] ?? [])],
        enabled: row.enabled,
        match: row.match,
        conditions: row.conditions,
        actions: row.actions,
        subject: row.subject,
        conditionsMet: row.conditions_met,
        steps: row.steps,
        attempts: row.attempts,
        createdAt: toDate(row.created_at),
        since: toDate(row.waited_until ?? row.created_at),
      }));
    });
  }

  /**
   * Records how a run's try went: finished; pending, to be tried again after
   * {@link retryDelayMs}, where an app's action did not answer and its day is not up; or
   * waiting until `resumeAt`, its tries counted afresh from then (ADR-886).
   */
  async finish(run: DueWorkflowRun, outcome: WorkflowRunOutcome, at: Date): Promise<void> {
    const finished = outcome.status !== 'pending';
    const resumeAt = outcome.resumeAt ?? null;
    await this.db.tenant(run.shopId, (tx) =>
      tx.execute(sql`
        UPDATE apps.workflow_runs
           SET status = ${outcome.status}, conditions_met = ${outcome.conditionsMet},
               steps = ${JSON.stringify(outcome.steps)}::jsonb,
               next_attempt_at = ${resumeAt ?? new Date(at.getTime() + retryDelayMs(run.attempts))},
               attempts = ${resumeAt ? 0 : run.attempts},
               waited_until = coalesce(${resumeAt}::timestamptz, waited_until),
               finished_at = ${finished ? at : null}
         WHERE shop_id = ${run.shopId} AND id = ${run.id}`),
    );
  }

  /**
   * Posts an app's action `extensionId` of a run, signed with the app's secret as its webhooks
   * are: `final` where trying again cannot help, as when the app was removed, took the action
   * back, or refused it with a 4xx other than 429.
   */
  async postAppAction(
    sender: WebhookSender,
    run: DueWorkflowRun,
    extensionId: string,
    properties: Record<string, string>,
    at: Date,
  ): Promise<{ error: string | null; final: boolean }> {
    const { rows } = await this.db.tenant(run.shopId, (tx) =>
      tx.execute<{
        handle: string;
        url: string;
        token_id: string;
        resource: FlowResource;
        webhook_secret: string | null;
      }>(sql`
        SELECT e.handle, e.url, e.token_id, e.resource, t.webhook_secret
          FROM apps.flow_extensions e ${LIVE}
         WHERE e.shop_id = ${run.shopId} AND e.id = ${extensionId} AND e.kind = 'action'`),
    );
    const action = rows[0];
    if (!action) return { error: "The app's action was taken back or removed", final: true };
    if (!action.webhook_secret) return { error: 'The app has no signing secret', final: true };
    const secret = this.box
      .decrypt(action.webhook_secret, sealedFor(run.shopId, action.token_id))
      .toString('utf8');
    const body = JSON.stringify({
      action: action.handle,
      shop_id: toPublicId('shop', run.shopId),
      workflow_id: toPublicId('workflow', run.workflowId),
      run_id: toPublicId('workflowRun', run.id),
      ...(action.resource === 'order' &&
        run.subject.orderId && { order_id: toPublicId('order', run.subject.orderId) }),
      ...(action.resource === 'customer' &&
        run.subject.customerId && { customer_id: toPublicId('customer', run.subject.customerId) }),
      properties,
    });
    const outcome = await sender.send({
      url: action.url,
      body,
      headers: {
        'x-hatti-topic': 'flow/action',
        'x-hatti-shop-id': toPublicId('shop', run.shopId),
        'x-hatti-workflow-run-id': toPublicId('workflowRun', run.id),
        'x-hatti-triggered-at': at.toISOString(),
        'x-hatti-hmac-sha256': signWebhook(secret, body),
      },
    });
    const refused =
      outcome.status !== null &&
      outcome.status >= 400 &&
      outcome.status < 500 &&
      outcome.status !== 429;
    return { error: outcome.error, final: refused };
  }

  // ── Within ─────────────────────────────────────────────────────────────────────────────────

  async #workflows(tx: Tx, shopId: string, where: SQL): Promise<WorkflowRecord[]> {
    const { rows } = await tx.execute<WorkflowRow>(sql`
      SELECT w.id, w.name, w.trigger, w.extension_id, w.match, w.conditions, w.actions,
             w.enabled, w.schedule, w.created_at, w.updated_at,
             (SELECT row_to_json(last) FROM (
                SELECT r.status, r.created_at FROM apps.workflow_runs r
                 WHERE r.shop_id = w.shop_id AND r.workflow_id = w.id
                 ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last) AS last_run
        FROM apps.workflows w
       WHERE w.shop_id = ${shopId} AND ${where}
       ORDER BY w.created_at, w.id`);
    const ids = rows.flatMap((row) => (row.extension_id ? [row.extension_id] : []));
    const extensions =
      ids.length === 0
        ? []
        : await extensionsIn(tx, shopId, sql`e.id = ANY (${sql.param(ids)}::uuid[])`);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      extension: extensions.find((each) => each.id === row.extension_id) ?? null,
      match: row.match,
      conditions: row.conditions,
      actions: row.actions,
      enabled: row.enabled,
      schedule: row.schedule,
      lastRun: row.last_run && {
        status: row.last_run.status,
        createdAt: toDate(row.last_run.created_at),
      },
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    }));
  }

  async #saved(
    tx: Tx,
    tenant: TenantContext,
    id: string,
    action: 'workflow.created' | 'workflow.updated',
  ): Promise<MutationResult<WorkflowRecord>> {
    const [record] = await this.#workflows(tx, tenant.shopId, sql`w.id = ${id}`);
    await recordAudit(tx, tenant.shopId, {
      action,
      subjectType: 'workflow',
      subjectId: id,
      ...actorColumnsOf(tenant.actor),
      details: { name: record!.name, trigger: record!.trigger, enabled: record!.enabled },
    });
    return { ok: true, value: record! };
  }
}

async function extensionsIn(tx: Tx, shopId: string, where: SQL): Promise<FlowExtensionRecord[]> {
  const { rows } = await tx.execute<ExtensionRow>(sql`
    SELECT ${EXTENSION_COLUMNS} FROM apps.flow_extensions e ${LIVE}
     WHERE e.shop_id = ${shopId} AND ${where}
     ORDER BY t.name, e.kind, e.title, e.id`);
  return rows.map(toExtension);
}

/** An app's fields, checked: keys of lowercase letters, digits and underscores, once each. */
function checkFields(check: InputChecker, input: NonNullable<FlowExtensionInput['fields']>) {
  if (input.length > WORKFLOW_LIMITS.fields) {
    check.add(['input', 'fields'], 'TOO_MANY', `can be ${WORKFLOW_LIMITS.fields} at most`);
    return [];
  }
  const seen = new Set<string>();
  return input.map((field, index): FlowField => {
    const path = ['input', 'fields', String(index)];
    const key = field.key.trim();
    if (!FIELD_KEY.test(key) || key.length > WORKFLOW_LIMITS.fieldKey) {
      check.addMessage(
        [...path, 'key'],
        'INVALID',
        'Use lowercase letters, digits and underscores, starting with a letter',
      );
    } else if (seen.has(key)) {
      check.addMessage([...path, 'key'], 'TAKEN', `Another field is ${key} already`);
    }
    seen.add(key);
    const label = check.text([...path, 'label'], field.label, {
      required: true,
      max: WORKFLOW_LIMITS.title,
    });
    if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
      check.add([...path, 'type'], 'INVALID', 'must be text, number or boolean');
    }
    return {
      key,
      label: label ?? '',
      type: field.type as FlowField['type'],
      required: field.required ?? false,
    };
  });
}

/**
 * What an app's trigger sends, or a workflow gives its action: its fields alone, the required
 * ones given. `literal` values are what the app sent, of their fields' types; `template` ones a
 * workflow's, whose placeholders are checked as its other templates are.
 */
function checkProperties(
  check: InputChecker,
  fields: readonly FlowField[],
  input: readonly { key: string; value: string }[],
  kind: 'literal' | 'template',
  path: string[] = ['properties'],
): Record<string, string> {
  const properties: Record<string, string> = {};
  input.forEach((property, index) => {
    const field = fields.find((each) => each.key === property.key);
    const at = [...path, String(index), 'value'];
    if (!field) {
      check.addMessage([...path, String(index), 'key'], 'INVALID', `No field is ${property.key}`);
      return;
    }
    const value = property.value.trim();
    if (value.length > WORKFLOW_LIMITS.property) {
      check.add(at, 'TOO_LONG', `must be ${WORKFLOW_LIMITS.property} characters at most`);
    } else if (kind === 'literal' && value !== '') {
      if (field.type === 'number' && !Number.isFinite(Number(value))) {
        check.addMessage(at, 'INVALID', `${field.label} must be a number`);
      } else if (field.type === 'boolean' && value !== 'true' && value !== 'false') {
        check.addMessage(at, 'INVALID', `${field.label} must be true or false`);
      }
    }
    if (value !== '') properties[field.key] = value;
  });
  for (const field of fields) {
    if (field.required && !properties[field.key]) {
      check.addMessage(path, 'BLANK', `${field.label} can't be blank`);
    }
  }
  return properties;
}

interface CheckedWorkflow {
  name: string;
  trigger: WorkflowTrigger;
  extensionId: string | null;
  match: 'all' | 'any';
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
  schedule: WorkflowSchedule | null;
}

/**
 * A workflow as given, checked against the shop's apps' triggers and actions: conditions on what
 * its trigger tells of, and actions that have what they need, their templates naming that.
 */
async function checkWorkflow(
  tx: Tx,
  shopId: string,
  input: WorkflowInput,
): Promise<MutationResult<CheckedWorkflow>> {
  const check = new InputChecker();
  const name = check.text(['input', 'name'], input.name, {
    required: true,
    max: WORKFLOW_LIMITS.name,
  });
  if (!isWorkflowTrigger(input.trigger)) {
    return failOne(['input', 'trigger'], 'INVALID', 'Trigger is not one Hatti has');
  }
  const trigger = input.trigger;
  const extensions = await extensionsIn(tx, shopId, sql`true`);
  let extension: FlowExtensionRecord | null = null;
  if (trigger === 'app') {
    extension =
      extensions.find((each) => each.kind === 'trigger' && each.id === input.extensionId) ?? null;
    if (!extension) {
      check.addMessage(['input', 'extensionId'], 'NOT_FOUND', 'No app of the shop offers it');
    }
  }
  const fields = fieldsOf(trigger, extension);
  const keys = new Set(fields.map((field) => field.key));
  const conditions = input.conditions ?? [];
  if (conditions.length > WORKFLOW_LIMITS.conditions) {
    check.add(['input', 'conditions'], 'TOO_MANY', `can be ${WORKFLOW_LIMITS.conditions} at most`);
  }
  const conditionsOf = (
    path: string[],
    given: readonly { field: string; operator: string; value: string }[],
  ) =>
    given.map((condition, index): WorkflowCondition => {
      const checked = {
        field: condition.field,
        operator: condition.operator as ConditionOperator,
        value: condition.value.trim(),
      };
      const problem = conditionProblem(fields, checked);
      if (problem) check.add([...path, String(index), problem.on], 'INVALID', problem.message);
      return checked;
    });
  const checkedConditions = conditionsOf(['input', 'conditions'], conditions);

  const template = (path: string[], value: string) => {
    const unknown = placeholdersOf(value).filter((key) => !keys.has(key));
    if (unknown.length > 0) {
      check.addMessage(path, 'INVALID', `{{${unknown[0]}}} isn't something this trigger tells of`);
    }
  };
  const has = subjectsOf(trigger, extension?.resource ?? null);
  if (input.actions.length === 0) {
    check.addMessage(['input', 'actions'], 'BLANK', 'Give it an action to do');
  }
  if (input.actions.length > WORKFLOW_LIMITS.actions) {
    check.add(['input', 'actions'], 'TOO_MANY', `can be ${WORKFLOW_LIMITS.actions} at most`);
  }
  const actions = input.actions.flatMap((action, index): WorkflowAction[] => {
    const path = ['input', 'actions', String(index)];
    if (!Object.hasOwn(WORKFLOW_ACTIONS, action.type)) {
      check.addMessage([...path, 'type'], 'INVALID', 'Action is not one Hatti has');
      return [];
    }
    const type = action.type as WorkflowActionType;
    const needs = WORKFLOW_ACTIONS[type].needs;
    if (needs && !has[needs]) {
      check.addMessage([...path, 'type'], 'INVALID', `This trigger tells of no ${needs} to change`);
    }
    switch (type) {
      case 'add_order_tags':
      case 'remove_order_tags':
      case 'add_customer_tags':
      case 'remove_customer_tags': {
        const tags = check.tags([...path, 'tags'], action.tags ?? []);
        if (tags.length === 0) check.addMessage([...path, 'tags'], 'BLANK', 'Give a tag');
        if (tags.length > WORKFLOW_LIMITS.tags) {
          check.add([...path, 'tags'], 'TOO_MANY', `can be ${WORKFLOW_LIMITS.tags} at most`);
        }
        return [{ type, tags }];
      }
      case 'hold_order':
        return [{ type }];
      case 'notify_staff': {
        const title = check.text([...path, 'title'], action.title, {
          required: true,
          max: WORKFLOW_LIMITS.title,
        });
        const message = check.text([...path, 'message'], action.message, {
          required: true,
          max: WORKFLOW_LIMITS.message,
        });
        if (title) template([...path, 'title'], title);
        if (message) template([...path, 'message'], message);
        return [{ type, title: title ?? '', message: message ?? '' }];
      }
      case 'app_action': {
        const found = extensions.find(
          (each) => each.kind === 'action' && each.id === action.extensionId,
        );
        if (!found) {
          check.addMessage([...path, 'extensionId'], 'NOT_FOUND', 'No app of the shop offers it');
          return [];
        }
        if (found.resource !== 'none' && !has[found.resource]) {
          check.addMessage(
            [...path, 'extensionId'],
            'INVALID',
            `${found.title} needs a ${found.resource}, which this trigger doesn't tell of`,
          );
        }
        const properties = checkProperties(
          check,
          found.fields,
          action.properties ?? [],
          'template',
          [...path, 'properties'],
        );
        for (const [key, value] of Object.entries(properties)) {
          const index = (action.properties ?? []).findIndex((each) => each.key === key);
          template([...path, 'properties', String(index), 'value'], value);
        }
        return [{ type, extensionId: found.id, properties }];
      }
      case 'wait': {
        const hours = action.hours ?? 0;
        if (!Number.isInteger(hours) || hours < 1 || hours > WORKFLOW_LIMITS.waitHours) {
          check.addMessage(
            [...path, 'hours'],
            'INVALID',
            `A wait is a whole number of hours, 1 to ${WORKFLOW_LIMITS.waitHours}`,
          );
        }
        if (index === input.actions.length - 1) {
          check.addMessage([...path, 'type'], 'INVALID', 'A wait needs an action after it');
        }
        return [{ type, hours }];
      }
      case 'continue_if': {
        const given = action.conditions ?? [];
        if (given.length === 0) {
          check.addMessage([...path, 'conditions'], 'BLANK', 'Give a condition to check');
        }
        if (given.length > WORKFLOW_LIMITS.conditions) {
          check.add(
            [...path, 'conditions'],
            'TOO_MANY',
            `can be ${WORKFLOW_LIMITS.conditions} at most`,
          );
        }
        if (index === input.actions.length - 1) {
          check.addMessage([...path, 'type'], 'INVALID', 'A check needs an action after it');
        }
        return [
          {
            type,
            match: action.match === 'any' ? 'any' : 'all',
            conditions: conditionsOf([...path, 'conditions'], given),
          },
        ];
      }
    }
  });
  // When a scheduled workflow runs (ADR-906); none for the others.
  let schedule: WorkflowSchedule | null = null;
  if (trigger === 'scheduled') {
    const days = [...new Set(input.schedule?.days ?? [])].sort((a, b) => a - b);
    const hour = input.schedule?.hour;
    if (days.length === 0 || !days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
      check.addMessage(
        ['input', 'schedule', 'days'],
        'INVALID',
        'Give the days it runs, Monday 1 to Sunday 7',
      );
    }
    if (hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      check.addMessage(
        ['input', 'schedule', 'hour'],
        'INVALID',
        "Give the hour it runs, 0 to 23, of the shop's own time",
      );
    }
    schedule = { days, hour: hour ?? 0 };
  } else if (input.schedule) {
    check.addMessage(['input', 'schedule'], 'INVALID', 'A schedule is for scheduled workflows');
  }
  if (!check.ok) return fail(check.errors);
  return {
    ok: true,
    value: {
      name: name!,
      trigger,
      extensionId: extension?.id ?? null,
      match: input.match === 'any' ? 'any' : 'all',
      conditions: checkedConditions,
      actions,
      enabled: input.enabled ?? true,
      schedule,
    },
  };
}

/** The event a scheduled workflow's slot stands for (ADR-906): a UUID named by both. */
export function slotEventId(workflowId: string, slot: Date): string {
  const hex = createHash('sha256').update(`${workflowId}:${slot.toISOString()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
