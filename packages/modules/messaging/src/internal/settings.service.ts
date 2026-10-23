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
  paidByShop,
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
  /** Where Hatti's alerts to the shop go, in E.164 (ADR-157); none sends none. */
  alertsPhone: string | null;
  /**
   * Where replies to its customers' emails about their orders go (ADR-659): their Reply-To, and
   * their words say a reply reaches the shop. None says replies aren't read.
   */
  replyToEmail: string | null;
  /** How soon its staff answer a customer who writes, in minutes (ADR-760); null for no aim. */
  replyTargetMinutes: number | null;
  updatedAt: Date | null;
}

export interface MessagingSettingsInput {
  routing?: MessageRouting | null;
  language?: MessageLanguage | null;
  disabled?: readonly string[] | null;
  /** Left out, it stays; null or blank stops the alerts. */
  alertsPhone?: string | null;
  /** Left out, it stays; null or blank leaves replies unread. */
  replyToEmail?: string | null;
  /** Left out, it stays; null sets no time to answer by. */
  replyTargetMinutes?: number | null;
}

const DEFAULTS: MessagingSettingsRecord = {
  routing: 'rich',
  language: 'en',
  disabled: [],
  alertsPhone: null,
  replyToEmail: null,
  replyTargetMinutes: null,
  updatedAt: null,
};

/** The shop's messaging settings in the caller's transaction: the defaults while it set none. */
export async function settingsIn(tx: Tx, shopId: string): Promise<MessagingSettingsRecord> {
  const { rows } = await tx.execute<{
    routing: MessageRouting;
    language: MessageLanguage;
    disabled: MessageKind[];
    alerts_phone: string | null;
    reply_to_email: string | null;
    reply_target_minutes: number | null;
    updated_at: string | Date;
  }>(sql`
    SELECT routing, language, disabled, alerts_phone, reply_to_email, reply_target_minutes,
           updated_at
      FROM messaging.settings WHERE shop_id = ${shopId}`);
  const row = rows[0];
  return row
    ? {
        routing: row.routing,
        language: row.language,
        disabled: row.disabled,
        alertsPhone: row.alerts_phone,
        replyToEmail: row.reply_to_email,
        replyTargetMinutes: row.reply_target_minutes,
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
        const why =
          kind === 'checkout_reminder' || kind === 'checkout_offer'
            ? "checkout's recovery setting turns it on and off"
            : kind === 'review_request'
              ? 'the reviews setting turns it on and off'
              : kind === 'back_in_stock' || kind === 'cod_prepaid'
                ? 'its automation turns it on and off'
                : kind === 'store_open'
                  ? 'shoppers asked to hear when the shop opens'
                  : kind === 'gift_card'
                    ? 'it carries the gift card the customer bought'
                    : paidByShop(kind as MessageKind)
                      ? 'shoppers ask for it'
                      : 'it tells the shop of its bills with Hatti';
        check.add(['input', 'disabled'], 'INVALID', `can't turn off "${kind}": ${why}`);
        break;
      }
    }
    // A blank number stops the alerts; anything else must be a Pakistani mobile.
    const alertsPhone =
      input.alertsPhone === undefined
        ? undefined
        : input.alertsPhone?.trim()
          ? check.mobile(['input', 'alertsPhone'], input.alertsPhone)
          : null;
    // A blank address leaves replies unread; anything else must be one.
    const replyToEmail =
      input.replyToEmail === undefined
        ? undefined
        : (check.email(['input', 'replyToEmail'], input.replyToEmail)?.toLowerCase() ?? null);
    const replyTarget =
      input.replyTargetMinutes === undefined
        ? undefined
        : input.replyTargetMinutes === null
          ? null
          : check.integer(['input', 'replyTargetMinutes'], input.replyTargetMinutes, {
              min: 5,
              max: 1440,
            });
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await settingsIn(tx, tenant.shopId);
      const next = {
        routing: input.routing ?? current.routing,
        language: input.language ?? current.language,
        disabled: ((disabled ?? current.disabled) as MessageKind[]).sort(),
      };
      const phone = alertsPhone === undefined ? current.alertsPhone : alertsPhone;
      const replyTo = replyToEmail === undefined ? current.replyToEmail : replyToEmail;
      const target = replyTarget === undefined ? current.replyTargetMinutes : replyTarget;
      const changed = [
        ...(next.routing !== current.routing ? ['routing'] : []),
        ...(next.language !== current.language ? ['language'] : []),
        ...(next.disabled.join() !== [...current.disabled].sort().join() ? ['disabled'] : []),
        ...(phone !== current.alertsPhone ? ['alertsPhone'] : []),
        ...(replyTo !== current.replyToEmail ? ['replyToEmail'] : []),
        ...(target !== current.replyTargetMinutes ? ['replyTargetMinutes'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: current };
      await tx.execute(sql`
        INSERT INTO messaging.settings
               (shop_id, routing, language, disabled, alerts_phone, reply_to_email,
                reply_target_minutes)
        VALUES (${tenant.shopId}, ${next.routing}, ${next.language},
                ${sql.param(next.disabled)}::text[], ${phone}, ${replyTo}, ${target})
            ON CONFLICT (shop_id) DO UPDATE
                   SET routing = excluded.routing, language = excluded.language,
                       disabled = excluded.disabled, alerts_phone = excluded.alerts_phone,
                       reply_to_email = excluded.reply_to_email,
                       reply_target_minutes = excluded.reply_target_minutes,
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
        // Never the alerts number nor the address for replies: the log keeps no contact details.
        details: {
          changed,
          ...next,
          replyTargetMinutes: target,
          before: current.updatedAt
            ? { routing: current.routing, language: current.language, disabled: current.disabled }
            : null,
        },
      });
      return { ok: true, value: await settingsIn(tx, tenant.shopId) };
    });
  }
}
