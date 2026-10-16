import {
  InputChecker,
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SegmentService } from '@hatti/customers/public';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NO_NAME, audienceQuery, firstName, workerTenant } from './broadcasts.service.js';
import { MessagingEvents, type MarketingAutomationUpdatedPayload } from './events.js';
import { MessagesService } from './messages.service.js';
import {
  WhatsAppTemplatesService,
  type WhatsAppTemplateRecord,
} from './whatsapp-templates.service.js';

/** The shop's automations' recipes (MKT-04, ADR-425, ADR-429). */
export const AUTOMATION_KINDS = ['welcome', 'win_back', 'back_in_stock'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** Recipes that send Hatti's own template from its shared number, needing none of the shop's. */
const HATTI_TEMPLATE_KINDS: readonly AutomationKind[] = ['back_in_stock'];

/** How many days after a customer's last order a win-back goes: by default, and its bounds. */
export const WIN_BACK_DAYS = { default: 60, min: 14, max: 365 } as const;

/**
 * How many days past its day a lapsed customer is still won back: a sweep missed, as when the
 * worker was down, is made up for within a week.
 */
export const WIN_BACK_GRACE_DAYS = 7;

/** The customers a round of the win-back sweep takes of one shop. */
const WIN_BACK_BATCH = 500;

/** A customer an automation greets: their number and the name the shop has for them. */
export interface AutomationCustomer {
  id: string;
  phone: string;
  name: string | null;
}

/** One of the shop's automations, as the Admin API shows it (ADR-425). */
export interface AutomationRecord {
  kind: AutomationKind;
  enabled: boolean;
  /**
   * The template it sends: null when none was chosen, or the one chosen is gone, and for back in
   * stock, which sends Hatti's own.
   */
  template: WhatsAppTemplateRecord | null;
  /** For a win-back: how many days after the customer's last order. */
  afterDays: number | null;
  /** When the shop last changed it; null for one never set. */
  updatedAt: Date | null;
}

export interface AutomationInput {
  enabled?: boolean;
  templateId?: string | null;
  afterDays?: number | null;
}

type AutomationRow = {
  kind: AutomationKind;
  enabled: boolean;
  template_id: string | null;
  after_days: number | null;
  updated_at: string | Date;
};

/**
 * A shop's marketing automations (MKT-04, ADR-425): recipes that send one of its own approved
 * WhatsApp templates (ADR-420) from its own number (ADR-419) to a customer who agreed to hear from
 * it there, as broadcasts are sent (ADR-422). A welcome goes once, when a customer subscribes at
 * checkout or on the storefront; a win-back goes some days after a customer's last order, once
 * for each time they lapse. Back in stock (ADR-429) tells a shopper who asked on the storefront,
 * once, from Hatti's number, when a sold-out variant is for sale again. Changing one is audited
 * and an event.
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly db: Database,
    private readonly templates: WhatsAppTemplatesService,
    private readonly segments: SegmentService,
    private readonly messages: MessagesService,
  ) {}

  /** Each of the shop's automations, as set, or off where it never was. */
  async list(tenant: TenantContext): Promise<AutomationRecord[]> {
    const rows = await this.db.tenant(tenant.shopId, (tx) => automationsIn(tx, tenant.shopId));
    const templates = await this.templates.list(tenant);
    return AUTOMATION_KINDS.map((kind) => {
      const row = rows.find((each) => each.kind === kind);
      return {
        kind,
        enabled: row?.enabled ?? false,
        template: templates.find((each) => each.id === row?.template_id) ?? null,
        afterDays: kind === 'win_back' ? (row?.after_days ?? WIN_BACK_DAYS.default) : null,
        updatedAt: row ? toDate(row.updated_at) : null,
      };
    });
  }

  /**
   * Changes one of the shop's automations: on only with a template Meta approved on the shop's
   * number, and a win-back's days within their bounds.
   */
  async update(
    tenant: TenantContext,
    kind: AutomationKind,
    input: AutomationInput,
  ): Promise<MutationResult<AutomationRecord>> {
    const current = (await this.list(tenant)).find((each) => each.kind === kind)!;
    const check = new InputChecker();
    let afterDays = current.afterDays;
    if (input.afterDays !== undefined && input.afterDays !== null) {
      if (kind !== 'win_back') {
        check.addMessage(['input', 'afterDays'], 'INVALID', 'Only a win-back waits some days');
      } else if (
        !Number.isInteger(input.afterDays) ||
        input.afterDays < WIN_BACK_DAYS.min ||
        input.afterDays > WIN_BACK_DAYS.max
      ) {
        check.addMessage(
          ['input', 'afterDays'],
          'INVALID',
          `A win-back goes between ${WIN_BACK_DAYS.min} and ${WIN_BACK_DAYS.max} days after the last order`,
        );
      } else {
        afterDays = input.afterDays;
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    const hatti = HATTI_TEMPLATE_KINDS.includes(kind);
    if (hatti && input.templateId) {
      return failOne(
        ['input', 'templateId'],
        'INVALID',
        "Back in stock is sent from Hatti's number, with no template of the shop's",
      );
    }
    const templateId = hatti
      ? null
      : input.templateId === undefined
        ? (current.template?.id ?? null)
        : input.templateId;
    const enabled = input.enabled ?? current.enabled;
    let template: WhatsAppTemplateRecord | null = null;
    if (templateId) {
      template = (await this.templates.list(tenant)).find((each) => each.id === templateId) ?? null;
      if (!template) {
        return failOne(
          ['input', 'templateId'],
          'NOT_FOUND',
          "No such template on the shop's number",
        );
      }
    }
    if (enabled && !hatti) {
      if (!template) {
        return failOne(['input', 'templateId'], 'BLANK', 'Choose the template it sends');
      }
      if (template.status !== 'approved') {
        return failOne(['input', 'templateId'], 'INVALID', "Meta hasn't approved this template");
      }
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<AutomationRow>(sql`
        INSERT INTO messaging.automations (shop_id, kind, enabled, template_id, after_days)
        VALUES (${tenant.shopId}, ${kind}, ${enabled}, ${templateId}, ${afterDays})
        ON CONFLICT (shop_id, kind) DO UPDATE
           SET enabled = EXCLUDED.enabled, template_id = EXCLUDED.template_id,
               after_days = EXCLUDED.after_days, updated_at = now()
        RETURNING kind, enabled, template_id, after_days, updated_at`);
      const row = rows[0]!;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MarketingAutomationUpdatedPayload>(tx, tenant.shopId, {
        type: MessagingEvents.MarketingAutomationUpdated,
        aggregateType: 'shop',
        aggregateId: tenant.shopId,
        payload: { kind, enabled, ...actor },
      });
      await recordAudit(tx, tenant.shopId, {
        action: MessagingEvents.MarketingAutomationUpdated,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { kind, enabled, template: template?.name ?? null, afterDays },
      });
      return {
        ok: true,
        value: {
          kind,
          enabled: row.enabled,
          template,
          afterDays: row.after_days,
          updatedAt: toDate(row.updated_at),
        },
      };
    });
  }

  /**
   * Welcomes a customer who has just agreed to hear from the shop on WhatsApp, where its welcome
   * is on and its template approved: once, however often they subscribe. The ID of the message
   * queued; null where none was.
   */
  async welcome(shopId: string, customer: AutomationCustomer): Promise<string | null> {
    const template = await this.#ready(shopId, 'welcome');
    if (!template) return null;
    return this.db.tenant(shopId, async (tx) =>
      this.#queueIn(tx, shopId, 'welcome', template, customer, `automation:welcome:${customer.id}`),
    );
  }

  /** The shops whose win-back is on, whichever: the worker's to sweep. */
  async winBackShops(): Promise<string[]> {
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM messaging.automations
         WHERE kind = 'win_back' AND enabled
         ORDER BY shop_id`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Wins back the shop's customers who agreed to hear from it on WhatsApp and whose last order
   * was the win-back's days ago, or up to a week more for a sweep missed: each once for each time
   * they lapse, as none went to them in that time. How many messages it queued.
   */
  async winBack(shopId: string, at: Date = new Date()): Promise<number> {
    const template = await this.#ready(shopId, 'win_back');
    if (!template) return 0;
    const rows = await this.db.tenant(shopId, (tx) => automationsIn(tx, shopId));
    const days = rows.find((row) => row.kind === 'win_back')?.after_days ?? WIN_BACK_DAYS.default;
    const lapsed = audienceQuery(
      `last_order_date <= -${days}d AND last_order_date > -${days + WIN_BACK_GRACE_DAYS}d`,
    );
    const since = new Date(at.getTime() - (days + WIN_BACK_GRACE_DAYS) * 86_400_000);
    const day = at.toISOString().slice(0, 10);
    let queued = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.segments.members(workerTenant(shopId), lapsed, {
        first: WIN_BACK_BATCH,
        after,
      });
      if (page.items.length > 0) {
        queued += await this.db.tenant(shopId, async (tx) => {
          const { rows: sent } = await tx.execute<{ customer_id: string }>(sql`
            SELECT DISTINCT customer_id FROM messaging.messages
             WHERE shop_id = ${shopId} AND kind = 'automation'
               AND variables ->> 'automation' = 'win_back'
               AND customer_id = ANY(${sql.param(page.items.map((each) => each.id))}::uuid[])
               AND created_at > ${since.toISOString()}`);
          const done = new Set(sent.map((row) => row.customer_id));
          let count = 0;
          for (const customer of page.items) {
            if (done.has(customer.id)) continue;
            const id = await this.#queueIn(
              tx,
              shopId,
              'win_back',
              template,
              customer,
              `automation:win_back:${customer.id}:${day}`,
            );
            if (id) count++;
          }
          return count;
        });
      }
      if (!page.hasNextPage) return queued;
      after = page.items.at(-1)!.id;
    }
  }

  /** The automation's template, where it is on and Meta approves the template; else null. */
  async #ready(shopId: string, kind: AutomationKind): Promise<WhatsAppTemplateRecord | null> {
    const rows = await this.db.tenant(shopId, (tx) => automationsIn(tx, shopId));
    const row = rows.find((each) => each.kind === kind);
    if (!row?.enabled || !row.template_id) return null;
    const template = (await this.templates.list(workerTenant(shopId))).find(
      (each) => each.id === row.template_id,
    );
    return template?.status === 'approved' ? template : null;
  }

  async #queueIn(
    tx: Tx,
    shopId: string,
    kind: AutomationKind,
    template: WhatsAppTemplateRecord,
    customer: AutomationCustomer,
    dedupeKey: string,
  ): Promise<string | null> {
    const { name: shop } = await shopProfile(tx, shopId);
    return this.messages.queueIn(tx, shopId, {
      kind: 'automation',
      recipient: customer.phone,
      customerId: customer.id,
      variables: {
        shop,
        template: template.name,
        automation: kind,
        ...(template.body.includes('{{1}}') && {
          name: firstName(customer.name) ?? NO_NAME[template.language],
        }),
      },
      dedupeKey,
      channel: 'whatsapp',
      language: template.language,
    });
  }
}

async function automationsIn(tx: Tx, shopId: string): Promise<AutomationRow[]> {
  const { rows } = await tx.execute<AutomationRow>(sql`
    SELECT kind, enabled, template_id, after_days, updated_at
      FROM messaging.automations WHERE shop_id = ${shopId}`);
  return rows;
}

/** Whether the shop's automation of `kind` is on, in the caller's transaction `tx`. */
export async function automationOnIn(
  tx: Tx,
  shopId: string,
  kind: AutomationKind,
): Promise<boolean> {
  return (await automationsIn(tx, shopId)).some((row) => row.kind === kind && row.enabled);
}
