import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import {
  CONTACT_MESSAGE_LIMITS,
  contactMessagesPath,
  type ContactMessageErrorResponse,
  type ContactMessageRequest,
  type ContactMessageResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { isIP } from 'node:net';
import { MessagingEvents, type ContactMessageReceivedPayload } from './events.js';
import type { Page } from './messages.service.js';

// Messages through the online store's contact form (OS-08, ADR-589), Shopify's
// `{% form 'contact' %}`: what a shopper writes to the shop from its contact page, kept for its
// staff to read beside the inbox. Shopify emails them to the shop; Hatti keeps them, as most of its
// shops answer on WhatsApp. An email or a mobile number to answer on is needed; the form's other
// fields are kept by their names.

/** A message from the contact form, as the shop's staff read it. */
export interface ContactMessageRecord {
  id: string;
  name: string | null;
  /** Lower case. */
  email: string | null;
  /** E.164. */
  phone: string | null;
  body: string;
  /** The form's other fields by their names, in the order they came. */
  fields: Record<string, string>;
  page: string | null;
  language: 'en' | 'ur';
  receivedAt: Date;
  readAt: Date | null;
}

/** The form's own fields, kept apart from its others. */
const OWN_FIELDS = new Set(['name', 'email', 'phone', 'body']);

type ContactMessageRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  body: string;
  fields: Record<string, string>;
  page: string | null;
  language: 'en' | 'ur';
  created_at: string | Date;
  read_at: string | Date | null;
};

const SELECT = sql`
  SELECT id, name, email, phone, body, fields, page, language, created_at, read_at
    FROM messaging.contact_messages`;

function toRecord(row: ContactMessageRow): ContactMessageRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    body: row.body,
    fields: row.fields,
    page: row.page,
    language: row.language,
    receivedAt: toDate(row.created_at),
    readAt: toDateOrNull(row.read_at),
  };
}

/** The form's other fields, checked: by name, at most {@link CONTACT_MESSAGE_LIMITS.fields}. */
function otherFields(check: InputChecker, fields: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return kept;
  for (const [rawName, rawValue] of Object.entries(fields as Record<string, unknown>)) {
    const name = rawName.trim();
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || OWN_FIELDS.has(name.toLowerCase())) continue;
    if (Object.keys(kept).length === CONTACT_MESSAGE_LIMITS.fields) {
      check.addMessage(['fields'], 'TOO_MANY', 'The form has too many fields');
      break;
    }
    if (name.length > CONTACT_MESSAGE_LIMITS.fieldName) {
      check.addMessage(['fields'], 'TOO_LONG', 'A field of the form has too long a name');
      break;
    }
    if (value.length > CONTACT_MESSAGE_LIMITS.fieldValue) {
      // The theme's own name for it, as the shopper saw it.
      check.addMessage(
        [name],
        'TOO_LONG',
        `${name} is too long (maximum is ${CONTACT_MESSAGE_LIMITS.fieldValue} characters)`,
      );
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

@Injectable()
export class ContactMessagesService {
  constructor(private readonly db: Database) {}

  /**
   * A shopper's message from the shop's contact form: kept, or what was wrong with it, the errors
   * naming `email`, `phone`, `body`, `name` or one of the form's other fields.
   */
  async receive(
    shopId: string,
    input: ContactMessageRequest,
  ): Promise<MutationResult<{ id: string }>> {
    const check = new InputChecker();
    const name = check.text(['name'], input.name, { max: CONTACT_MESSAGE_LIMITS.name });
    const email = check.email(['email'], input.email);
    const phone = check.mobile(['phone'], input.phone);
    if (
      email === null &&
      phone === null &&
      !check.errors.some((error) => error.field[0] === 'email' || error.field[0] === 'phone')
    ) {
      check.add(['email'], 'BLANK', 'or a mobile number is needed, to answer you');
    }
    const body = check.text(['body'], input.body, {
      required: true,
      max: CONTACT_MESSAGE_LIMITS.body,
    });
    const fields = otherFields(check, input.fields);
    if (!check.ok || body === null) return fail(check.errors);
    const page = input.page?.trim().slice(0, CONTACT_MESSAGE_LIMITS.page) || null;
    const language = input.language === 'ur' ? 'ur' : 'en';
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO messaging.contact_messages
          (shop_id, name, email, phone, body, fields, page, language, ip, user_agent)
        VALUES (${shopId}, ${name}, ${email?.toLowerCase() ?? null}, ${phone}, ${body},
                ${JSON.stringify(fields)}::jsonb, ${page}, ${language},
                ${input.ip && isIP(input.ip) ? input.ip : null}::inet,
                ${input.userAgent?.slice(0, CONTACT_MESSAGE_LIMITS.userAgent) || null})
        RETURNING id`);
      const id = rows[0]!.id;
      await appendEvent<ContactMessageReceivedPayload>(tx, shopId, {
        type: MessagingEvents.ContactMessageReceived,
        aggregateType: 'contact_message',
        aggregateId: id,
        payload: { language },
      });
      return { ok: true, value: { id } };
    });
  }

  /** The shop's messages, the latest first; with `unread`, those its staff have not read alone. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null; unread?: boolean },
  ): Promise<Page<ContactMessageRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<ContactMessageRow>(sql`
        ${SELECT}
         WHERE shop_id = ${tenant.shopId}
           ${options.unread ? sql`AND read_at IS NULL` : sql``}
           ${options.after ? sql`AND id < ${options.after}` : sql``}
         ORDER BY id DESC
         LIMIT ${options.first + 1}`);
      return {
        items: rows.slice(0, options.first).map(toRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** The shop's message `id`; null if it has none. */
  async get(tenant: TenantContext, id: string): Promise<ContactMessageRecord | null> {
    return this.db.tenant(tenant.shopId, (tx) => messageIn(tx, tenant.shopId, id));
  }

  /** How many of the shop's messages its staff have not read. */
  async unreadCount(tenant: TenantContext): Promise<number> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.contact_messages
         WHERE shop_id = ${tenant.shopId} AND read_at IS NULL`),
    );
    return rows[0]!.count;
  }

  /** Marks the message read, or unread again: the message after; null if the shop has none. */
  async markRead(
    tenant: TenantContext,
    id: string,
    read: boolean,
  ): Promise<ContactMessageRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE messaging.contact_messages
           SET read_at = CASE WHEN ${read} THEN coalesce(read_at, now()) END
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return messageIn(tx, tenant.shopId, id);
    });
  }

  /** Deletes the message: whether the shop had it. */
  async delete(tenant: TenantContext, id: string): Promise<boolean> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        DELETE FROM messaging.contact_messages
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`),
    );
    return rows.length > 0;
  }
}

async function messageIn(tx: Tx, shopId: string, id: string): Promise<ContactMessageRecord | null> {
  const { rows } = await tx.execute<ContactMessageRow>(sql`
    ${SELECT} WHERE shop_id = ${shopId} AND id = ${id}`);
  return rows[0] ? toRecord(rows[0]) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Messages through the online store's contact form, as storefronts send them on (ADR-589):
 * `POST /storefront/shops/{shop}/contact-messages` with the form's `name`, `email`, `phone`,
 * `body` and other `fields`, and where it came from. 422 says what was wrong with it. The host
 * application checks the storefront key before any of this runs.
 */
@Controller(contactMessagesPath(':shopId').slice(1))
export class StorefrontContactMessagesController {
  constructor(private readonly messages: ContactMessagesService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async post(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
  ): Promise<ContactMessageResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const given =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof given[name] === 'string' ? given[name] : undefined);
    const result = await this.messages.receive(shopId, {
      name: text('name'),
      email: text('email'),
      phone: text('phone'),
      body: text('body') ?? '',
      fields: given.fields as Record<string, string> | undefined,
      page: text('page'),
      language: text('language') === 'ur' ? 'ur' : 'en',
      ip: text('ip'),
      userAgent: text('userAgent'),
    });
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies ContactMessageErrorResponse);
    }
    return { id: toPublicId('contactMessage', result.value.id) };
  }
}
