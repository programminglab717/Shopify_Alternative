import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MessagingEvents,
  type WhatsAppTemplateChangedPayload,
  type WhatsAppTemplateStatusPayload,
} from './events.js';
import {
  LIBRARY_KINDS,
  LIBRARY_LANGUAGES,
  LIBRARY_LIMITS,
  libraryKey,
  libraryTemplate,
} from './template-library.js';
import type { MessageLanguage } from './templates.js';
import { WhatsAppAccountsService } from './whatsapp-accounts.service.js';
import type { WhatsAppBusinessClient } from './whatsapp-business.js';
import type { TemplateStatusUpdate } from './whatsapp-webhook.js';

export const WHATSAPP_TEMPLATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

/** How long what a shop writes may be, as Meta takes it. */
export const WHATSAPP_TEMPLATE_LIMITS = {
  name: 100,
  header: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  buttonUrl: 2000,
  /** Templates on one account: Meta allows more, a shop needs fewer. */
  perAccount: 100,
} as const;

/** A shop's own template, as the Admin API shows it (ADR-420). */
export interface WhatsAppTemplateRecord {
  id: string;
  name: string;
  language: MessageLanguage;
  header: string | null;
  body: string;
  footer: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  status: WhatsAppTemplateStatus;
  rejectedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WhatsAppTemplateInput {
  name: string;
  language: MessageLanguage;
  header?: string | null;
  body: string;
  footer?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
}

type TemplateRow = {
  id: string;
  name: string;
  language: MessageLanguage;
  header: string | null;
  body: string;
  footer: string | null;
  button_text: string | null;
  button_url: string | null;
  status: WhatsAppTemplateStatus;
  meta_template_id: string;
  rejected_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const COLUMNS = sql`id, name, language, header, body, footer, button_text, button_url, status,
                    meta_template_id, rejected_reason, created_at, updated_at`;

/** Meta's statuses as Hatti keeps them; those it does not name here leave a template as it is. */
const META_STATUSES: Record<string, WhatsAppTemplateStatus> = {
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  APPROVED: 'approved',
  REINSTATED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  PENDING_DELETION: 'disabled',
  DELETED: 'disabled',
};

/** How far Meta has come with Hatti's order templates on the shop's account (ADR-537). */
export interface WhatsAppLibraryRecord {
  /** The templates the library has: each kind of order news in each language. */
  total: number;
  approved: number;
  pending: number;
  /** Refused, paused or disabled by Meta: those kinds go from Hatti's number. */
  refused: number;
  /** When the library was last sent to the account; null before it first is. */
  triedAt: Date | null;
}

/** What sending the library to an account came to: how many Meta took, or had, and why not. */
export interface LibrarySent {
  submitted: number;
  /** Those the account had already, as from a shop connected before. */
  adopted: number;
  errors: string[];
}

/** The names Hatti's own templates have, which a shop's cannot take (ADR-537). */
const HATTI_PREFIX = 'hatti_';

/** {{1}} and its like, as Meta reads them. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * A shop's own marketing templates (MKT-01, ADR-420), which broadcasts send from its own number
 * (ADR-419): each written in the admin, sent at once to Meta for approval on the shop's WhatsApp
 * Business Account in the marketing category, and kept as Meta says it stands, from its webhook or
 * when the shop asks again. A body may name the customer with {{1}}, their first name; nothing
 * else is a variable. Meta's words for what it refuses are the shop's to read. Created and deleted
 * templates are audited, and each is an event, as each change of status is.
 */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    private readonly db: Database,
    private readonly accounts: WhatsAppAccountsService,
  ) {}

  /** The templates of the account the shop has connected, the latest first; none without one. */
  async list(tenant: TenantContext): Promise<WhatsAppTemplateRecord[]> {
    const sender = await this.accounts.senderOf(tenant.shopId);
    if (!sender) return [];
    return this.db.tenant(tenant.shopId, async (tx) =>
      (await templatesIn(tx, tenant.shopId, sender.businessAccountId)).map(toRecord),
    );
  }

  /** One of the shop's templates, of whichever account; null if there is none. */
  async get(shopId: string, id: string): Promise<WhatsAppTemplateRecord | null> {
    return this.db.tenant(shopId, async (tx) => {
      const row = await templateIn(tx, shopId, id);
      return row && toRecord(row);
    });
  }

  /** Writes a template and sends it to Meta for approval: kept only once Meta has it. */
  async create(
    tenant: TenantContext,
    input: WhatsAppTemplateInput,
  ): Promise<MutationResult<WhatsAppTemplateRecord>> {
    const check = new InputChecker();
    const template = checkTemplate(check, input);
    if (!check.ok || !template) return { ok: false, errors: check.errors };
    const sender = await this.accounts.senderOf(tenant.shopId);
    if (!sender) {
      return failOne(['input'], 'INVALID', "Connect the shop's own WhatsApp number first");
    }
    const graph = this.accounts.graph;
    if (!graph) return failOne(['input'], 'UNAVAILABLE', "WhatsApp isn't set up on this server");

    const existing = await this.db.tenant(tenant.shopId, (tx) =>
      templatesIn(tx, tenant.shopId, sender.businessAccountId),
    );
    if (existing.some((row) => row.name === template.name && row.language === template.language)) {
      return failOne(
        ['input', 'name'],
        'TAKEN',
        'The shop already has a template of this name in this language',
      );
    }
    if (existing.length >= WHATSAPP_TEMPLATE_LIMITS.perAccount) {
      return failOne(
        ['input'],
        'TOO_MANY',
        `A shop keeps ${WHATSAPP_TEMPLATE_LIMITS.perAccount} templates at most: delete one first`,
      );
    }

    const created = await graph.createTemplate(sender.accessToken, sender.businessAccountId, {
      name: template.name,
      language: template.language,
      header: template.header,
      body: template.body,
      footer: template.footer,
      button:
        template.buttonText && template.buttonUrl
          ? { text: template.buttonText, url: template.buttonUrl }
          : null,
    });
    if (!created.ok) return failOne(['input'], 'INVALID', created.error);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<TemplateRow>(sql`
        INSERT INTO messaging.whatsapp_templates
               (shop_id, business_account_id, name, language, header, body, footer, button_text,
                button_url, status, meta_template_id)
        VALUES (${tenant.shopId}, ${sender.businessAccountId}, ${template.name},
                ${template.language}, ${template.header}, ${template.body}, ${template.footer},
                ${template.buttonText}, ${template.buttonUrl},
                ${META_STATUSES[created.value.status] ?? 'pending'}, ${created.value.id})
        RETURNING ${COLUMNS}`);
      const row = rows[0]!;
      await this.#changed(tx, tenant, row, MessagingEvents.WhatsAppTemplateCreated);
      return { ok: true, value: toRecord(row) };
    });
  }

  /**
   * Deletes a template, from Meta too while the shop still has the account it was sent to. Meta
   * refusing leaves it as it was; one Meta no longer has, deleted there, goes. Its ID, once gone.
   */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    const row = await this.db.tenant(tenant.shopId, (tx) => templateIn(tx, tenant.shopId, id));
    if (!row) return failOne(['id'], 'NOT_FOUND', 'No such template');
    const sender = await this.accounts.senderOf(tenant.shopId);
    const graph = this.accounts.graph;
    if (sender && graph && sender.businessAccountId === row.business_account_id) {
      const deleted = await graph.deleteTemplate(
        sender.accessToken,
        sender.businessAccountId,
        row.name,
        row.meta_template_id,
      );
      if (!deleted.ok && !deleted.notFound) return failOne(['id'], 'UNAVAILABLE', deleted.error);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<TemplateRow & { business_account_id: string }>(sql`
        DELETE FROM messaging.whatsapp_templates
         WHERE shop_id = ${tenant.shopId} AND id = ${id} AND library_kind IS NULL
        RETURNING ${COLUMNS}, business_account_id`);
      const gone = rows[0];
      if (!gone) return failOne<string>(['id'], 'NOT_FOUND', 'No such template');
      await this.#changed(tx, tenant, gone, MessagingEvents.WhatsAppTemplateDeleted);
      return { ok: true, value: id };
    });
  }

  /** Asks Meta how the shop's templates stand, and keeps what it says: the shop's templates. */
  async sync(tenant: TenantContext): Promise<MutationResult<WhatsAppTemplateRecord[]>> {
    const sender = await this.accounts.senderOf(tenant.shopId);
    const graph = this.accounts.graph;
    if (!sender || !graph) return { ok: true, value: [] };
    const found = await graph.templatesOf(sender.accessToken, sender.businessAccountId);
    if (!found.ok) return failOne(['input'], 'UNAVAILABLE', found.error);
    for (const each of found.value) {
      await this.#record(tenant.shopId, null, {
        metaTemplateId: each.id,
        event: each.status,
        reason: each.rejectedReason,
      });
    }
    return { ok: true, value: await this.list(tenant) };
  }

  /**
   * The shops whose accounts lack some of Hatti's order templates (ADR-537), those never sent
   * them first: each at most once a day.
   */
  async libraryDue(
    at: Date = new Date(),
    limit: number = LIBRARY_LIMITS.shopsPerSweep,
  ): Promise<string[]> {
    const before = new Date(at.getTime() - LIBRARY_LIMITS.retryHours * 3_600_000);
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT a.shop_id FROM messaging.whatsapp_accounts a
         WHERE (a.library_tried_at IS NULL OR a.library_tried_at <= ${before})
           AND (SELECT count(*) FROM messaging.whatsapp_templates t
                 WHERE t.shop_id = a.shop_id AND t.business_account_id = a.business_account_id
                   AND t.library_kind IS NOT NULL) < ${LIBRARY_KINDS.length * LIBRARY_LANGUAGES.length}
         ORDER BY a.library_tried_at NULLS FIRST, a.shop_id
         LIMIT ${limit}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Sends the shop's account the order templates it lacks, each to Meta for approval in the
   * utility category through `graph`, with links to `orderPage` followed by an order's own part;
   * one the account has already, under its name and language, is kept as Meta says it stands.
   * Tried, whatever came of it, at `at`: not again for a day.
   */
  async sendLibrary(
    shopId: string,
    orderPage: string,
    graph: Pick<WhatsAppBusinessClient, 'templatesOf' | 'submitTemplate'>,
    at: Date = new Date(),
  ): Promise<LibrarySent> {
    const sent: LibrarySent = { submitted: 0, adopted: 0, errors: [] };
    const sender = await this.accounts.senderOf(shopId);
    if (!sender) return sent;
    const account = sender.businessAccountId;
    const have = await this.db.tenant(shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE messaging.whatsapp_accounts SET library_tried_at = ${at}
         WHERE shop_id = ${shopId} AND business_account_id = ${account}`);
      const { rows } = await tx.execute<{ library_kind: string; language: string }>(sql`
        SELECT library_kind, language FROM messaging.whatsapp_templates
         WHERE shop_id = ${shopId} AND business_account_id = ${account}
           AND library_kind IS NOT NULL`);
      return new Set(rows.map((row) => libraryKey(row.library_kind, row.language)));
    });
    const found = await graph.templatesOf(sender.accessToken, account);
    if (!found.ok) return { ...sent, errors: [found.error] };
    for (const kind of LIBRARY_KINDS) {
      for (const language of LIBRARY_LANGUAGES) {
        if (have.has(libraryKey(kind, language))) continue;
        const template = libraryTemplate(kind, language, orderPage);
        const existing = found.value.find(
          (each) => each.name === template.name && each.language === language,
        );
        let meta = existing && {
          id: existing.id,
          status: existing.status,
          reason: existing.rejectedReason,
        };
        if (!meta) {
          const created = await graph.submitTemplate(sender.accessToken, account, template);
          if (!created.ok) {
            sent.errors.push(`${template.name} (${language}): ${created.error}`);
            continue;
          }
          meta = { id: created.value.id, status: created.value.status, reason: null };
        }
        const status = META_STATUSES[meta.status] ?? 'pending';
        const body = (template.components[0] as { text: string }).text;
        await this.db.tenant(shopId, (tx) =>
          tx.execute(sql`
            INSERT INTO messaging.whatsapp_templates
                   (shop_id, business_account_id, name, language, body, status, meta_template_id,
                    rejected_reason, library_kind)
            VALUES (${shopId}, ${account}, ${template.name}, ${language}, ${body}, ${status},
                    ${meta.id},
                    ${status === 'approved' || status === 'pending' ? null : (meta.reason?.slice(0, 500) ?? null)},
                    ${kind})
            ON CONFLICT DO NOTHING`),
        );
        if (existing) sent.adopted++;
        else sent.submitted++;
      }
    }
    return sent;
  }

  /**
   * The order templates Meta approved on the shop's account `businessAccountId`, each by its kind
   * and language, as libraryKey names it: what goes from the shop's own number.
   */
  async libraryApproved(shopId: string, businessAccountId: string): Promise<Set<string>> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ library_kind: string; language: string }>(sql`
        SELECT library_kind, language FROM messaging.whatsapp_templates
         WHERE shop_id = ${shopId} AND business_account_id = ${businessAccountId}
           AND library_kind IS NOT NULL AND status = 'approved'`),
    );
    return new Set(rows.map((row) => libraryKey(row.library_kind, row.language)));
  }

  /** How far Meta has come with the order templates on the shop's account; null without one. */
  async library(tenant: TenantContext): Promise<WhatsAppLibraryRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: accounts } = await tx.execute<{
        business_account_id: string;
        library_tried_at: string | Date | null;
      }>(sql`
        SELECT business_account_id, library_tried_at FROM messaging.whatsapp_accounts
         WHERE shop_id = ${tenant.shopId}`);
      const account = accounts[0];
      if (!account) return null;
      const { rows } = await tx.execute<{ status: WhatsAppTemplateStatus; count: number }>(sql`
        SELECT status, count(*)::int AS count FROM messaging.whatsapp_templates
         WHERE shop_id = ${tenant.shopId} AND business_account_id = ${account.business_account_id}
           AND library_kind IS NOT NULL
         GROUP BY status`);
      const count = (...statuses: WhatsAppTemplateStatus[]) =>
        rows
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + row.count, 0);
      return {
        total: LIBRARY_KINDS.length * LIBRARY_LANGUAGES.length,
        approved: count('approved'),
        pending: count('pending'),
        refused: count('rejected', 'paused', 'disabled'),
        triedAt: account.library_tried_at === null ? null : toDate(account.library_tried_at),
      };
    });
  }

  /**
   * What WhatsApp's webhook says of templates, whichever shop's: each kept as Meta says it now
   * stands. One Hatti does not know is left alone.
   */
  async recordStatuses(updates: readonly TemplateStatusUpdate[]): Promise<void> {
    for (const update of updates) {
      const { rows } = await this.db.app.execute<{ shop_id: string; template_id: string }>(sql`
        SELECT shop_id, template_id FROM messaging.resolve_whatsapp_template(${update.metaTemplateId})`);
      for (const row of rows) await this.#record(row.shop_id, row.template_id, update);
    }
  }

  async #record(
    shopId: string,
    templateId: string | null,
    update: TemplateStatusUpdate,
  ): Promise<void> {
    const status = META_STATUSES[update.event];
    if (!status) return;
    const reason = status === 'approved' || status === 'pending' ? null : update.reason;
    await this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string; status: WhatsAppTemplateStatus }>(sql`
        UPDATE messaging.whatsapp_templates
           SET status = ${status}, rejected_reason = ${reason}, updated_at = now()
         WHERE shop_id = ${shopId} AND meta_template_id = ${update.metaTemplateId}
           ${templateId ? sql`AND id = ${templateId}` : sql``}
           AND (status <> ${status} OR rejected_reason IS DISTINCT FROM ${reason})
        RETURNING id, status`);
      for (const row of rows) {
        await appendEvent<WhatsAppTemplateStatusPayload>(tx, shopId, {
          type: MessagingEvents.WhatsAppTemplateStatusChanged,
          aggregateType: 'whatsapp_template',
          aggregateId: row.id,
          payload: { status: row.status, reason },
        });
      }
    });
  }

  async #changed(
    tx: Tx,
    tenant: TenantContext,
    row: TemplateRow,
    type:
      | typeof MessagingEvents.WhatsAppTemplateCreated
      | typeof MessagingEvents.WhatsAppTemplateDeleted,
  ): Promise<void> {
    const actor = actorColumnsOf(tenant.actor);
    await appendEvent<WhatsAppTemplateChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'whatsapp_template',
      aggregateId: row.id,
      payload: { name: row.name, language: row.language, ...actor },
    });
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'whatsAppTemplate',
      subjectId: row.id,
      ...actor,
      details: { name: row.name, language: row.language, metaTemplateId: row.meta_template_id },
    });
  }
}

/** The template as given, checked, its optional parts null where blank; null if not valid. */
function checkTemplate(
  check: InputChecker,
  input: WhatsAppTemplateInput,
): {
  name: string;
  language: MessageLanguage;
  header: string | null;
  body: string;
  footer: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
} | null {
  const limits = WHATSAPP_TEMPLATE_LIMITS;
  const name = input.name.trim();
  if (!name) check.add(['input', 'name'], 'BLANK', "can't be blank");
  else if (name.length > limits.name) {
    check.add(['input', 'name'], 'TOO_LONG', `is too long (maximum is ${limits.name} characters)`);
  } else if (!/^[a-z0-9_]+$/.test(name)) {
    check.add(
      ['input', 'name'],
      'INVALID',
      'can have only lowercase letters, digits and underscores',
    );
  } else if (name.startsWith(HATTI_PREFIX)) {
    check.add(['input', 'name'], 'INVALID', `can't begin with ${HATTI_PREFIX}: Hatti's own do`);
  }
  const header = check.text(['input', 'header'], input.header, { max: limits.header }) ?? null;
  const body = check.text(['input', 'body'], input.body, { max: limits.body, required: true });
  const footer = check.text(['input', 'footer'], input.footer, { max: limits.footer }) ?? null;
  const buttonText =
    check.text(['input', 'buttonText'], input.buttonText, { max: limits.buttonText }) ?? null;
  const buttonUrl =
    check.text(['input', 'buttonUrl'], input.buttonUrl, { max: limits.buttonUrl }) ?? null;

  for (const [field, text] of [
    ['header', header],
    ['footer', footer],
    ['buttonText', buttonText],
    ['buttonUrl', buttonUrl],
  ] as const) {
    if (text && text.match(PLACEHOLDER)) {
      check.add(
        ['input', field],
        'INVALID',
        "can't have variables: only the body names the customer",
      );
    }
  }
  if (header?.includes('\n')) check.add(['input', 'header'], 'INVALID', 'must be one line');
  if (body) {
    const names = [...body.matchAll(PLACEHOLDER)].map((match) => match[1]);
    if (names.some((each) => each !== '1')) {
      check.add(
        ['input', 'body'],
        'INVALID',
        'can name the customer with {{1}} alone, their first name',
      );
    }
  }
  if ((buttonText === null) !== (buttonUrl === null)) {
    check.add(
      ['input', buttonText === null ? 'buttonText' : 'buttonUrl'],
      'BLANK',
      "can't be blank when the button has a link",
    );
  }
  if (buttonUrl && !isHttpsUrl(buttonUrl)) {
    check.add(['input', 'buttonUrl'], 'INVALID', 'must be an https:// address');
  }
  if (!check.ok || !body) return null;
  return { name, language: input.language, header, body, footer, buttonText, buttonUrl };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function templatesIn(
  tx: Tx,
  shopId: string,
  businessAccountId: string,
): Promise<TemplateRow[]> {
  const { rows } = await tx.execute<TemplateRow>(sql`
    SELECT ${COLUMNS} FROM messaging.whatsapp_templates
     WHERE shop_id = ${shopId} AND business_account_id = ${businessAccountId}
       AND library_kind IS NULL
     ORDER BY created_at DESC, id DESC`);
  return rows;
}

async function templateIn(
  tx: Tx,
  shopId: string,
  id: string,
): Promise<(TemplateRow & { business_account_id: string }) | null> {
  const { rows } = await tx.execute<TemplateRow & { business_account_id: string }>(sql`
    SELECT ${COLUMNS}, business_account_id FROM messaging.whatsapp_templates
     WHERE shop_id = ${shopId} AND id = ${id} AND library_kind IS NULL`);
  return rows[0] ?? null;
}

function toRecord(row: TemplateRow): WhatsAppTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    header: row.header,
    body: row.body,
    footer: row.footer,
    buttonText: row.button_text,
    buttonUrl: row.button_url,
    status: row.status,
    rejectedReason: row.rejected_reason,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}
