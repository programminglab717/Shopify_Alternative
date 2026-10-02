import { InputChecker, actorColumnsOf, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MessagingEvents, type MessagingSettingsUpdatedPayload } from './events.js';
import {
  ALWAYS_SENT,
  MESSAGE_KINDS,
  MESSAGE_LANGUAGES,
  type MessageKind,
  type MessageLanguage,
} from './templates.js';

/** WhatsApp for every update, or for those with buttons alone and SMS for the rest (07 §2.3). */
export const MESSAGE_ROUTINGS = ['rich', 'economy'] as const;
export type MessageRouting = (typeof MESSAGE_ROUTINGS)[number];

/** How the shop's customers are told about their orders; the defaults until it says otherwise. */
export interface MessagingSettingsRecord {
  routing: MessageRouting;
  language: MessageLanguage;
  /** The notifications it turned off. */
  disabled: MessageKind[];
  updatedAt: Date | null;
}

export interface MessagingSettingsInput {
  routing?: MessageRouting | null;
  language?: MessageLanguage | null;
  disabled?: readonly string[] | null;
}

const DEFAULTS: MessagingSettingsRecord = {
  routing: 'rich',
  language: 'en',
  disabled: [],
  updatedAt: null,
};

/** The shop's messaging settings in the caller's transaction: the defaults while it set none. */
export async function settingsIn(tx: Tx, shopId: string): Promise<MessagingSettingsRecord> {
  const { rows } = await tx.execute<{
    routing: MessageRouting;
    language: MessageLanguage;
    disabled: MessageKind[];
    updated_at: string | Date;
  }>(sql`
    SELECT routing, language, disabled, updated_at
      FROM messaging.settings WHERE shop_id = ${shopId}`);
  const row = rows[0];
  return row
    ? {
        routing: row.routing,
        language: row.language,
        disabled: row.disabled,
        updatedAt: toDateOrNull(row.updated_at),
      }
    : DEFAULTS;
}

/** How a shop's customers are told about their orders (MSG-01, ADR-146). */
@Injectable()
export class MessagingSettingsService {
  constructor(private readonly db: Database) {}

  async get(tenant: TenantContext): Promise<MessagingSettingsRecord> {
    return this.db.tenant(tenant.shopId, (tx) => settingsIn(tx, tenant.shopId));
  }

  /** Changes what is given: from the next message queued. Audited, and an event. */
  async update(
    tenant: TenantContext,
    input: MessagingSettingsInput,
  ): Promise<MutationResult<MessagingSettingsRecord>> {
    const check = new InputChecker();
    if (input.routing && !MESSAGE_ROUTINGS.includes(input.routing)) {
      check.add(['input', 'routing'], 'INVALID', 'must be rich or economy');
    }
    if (input.language && !MESSAGE_LANGUAGES.includes(input.language)) {
      check.add(['input', 'language'], 'INVALID', 'must be en or ur');
    }
    const disabled = input.disabled ? [...new Set(input.disabled)] : null;
    for (const kind of disabled ?? []) {
      if (!(MESSAGE_KINDS as readonly string[]).includes(kind)) {
        check.add(['input', 'disabled'], 'INVALID', `has no notification "${kind}"`);
        break;
      }
      if ((ALWAYS_SENT as readonly string[]).includes(kind)) {
        check.add(
          ['input', 'disabled'],
          'INVALID',
          `can't turn off "${kind}": shoppers ask for it`,
        );
        break;
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await settingsIn(tx, tenant.shopId);
      const next = {
        routing: input.routing ?? current.routing,
        language: input.language ?? current.language,
        disabled: ((disabled ?? current.disabled) as MessageKind[]).sort(),
      };
      const changed = [
        ...(next.routing !== current.routing ? ['routing'] : []),
        ...(next.language !== current.language ? ['language'] : []),
        ...(next.disabled.join() !== [...current.disabled].sort().join() ? ['disabled'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: current };
      await tx.execute(sql`
        INSERT INTO messaging.settings (shop_id, routing, language, disabled)
        VALUES (${tenant.shopId}, ${next.routing}, ${next.language},
                ${sql.param(next.disabled)}::text[])
            ON CONFLICT (shop_id) DO UPDATE
                   SET routing = excluded.routing, language = excluded.language,
                       disabled = excluded.disabled,
                       version = messaging.settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MessagingSettingsUpdatedPayload>(tx, tenant.shopId, {
        type: MessagingEvents.MessagingSettingsUpdated,
        aggregateType: 'messaging_settings',
        aggregateId: tenant.shopId,
        payload: { changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'messaging_settings.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { changed, ...next, before: current.updatedAt ? current : null },
      });
      return { ok: true, value: await settingsIn(tx, tenant.shopId) };
    });
  }
}
