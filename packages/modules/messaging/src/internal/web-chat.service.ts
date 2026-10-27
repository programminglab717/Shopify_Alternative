import { createHash, randomBytes } from 'node:crypto';
import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import {
  WEB_CHAT_LIMITS,
  webChatPath,
  type WebChatErrorResponse,
  type WebChatMessageJson,
  type WebChatResponse,
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
import {
  MessagingEvents,
  type ConversationMessageReceivedPayload,
  type WebChatUpdatedPayload,
} from './events.js';

/** The shop's web chat, as the Admin API shows it (MSG-10, ADR-810). */
export interface WebChatSettingsRecord {
  enabled: boolean;
  /** What the chat says before the shopper writes; null for Hatti's words. */
  greeting: string | null;
  /** When the shop last changed it; null for one never set. */
  updatedAt: Date | null;
}

export interface WebChatSettingsInput {
  enabled?: boolean | null;
  /** Left out, it stays; null or blank says Hatti's words. */
  greeting?: string | null;
}

/** A message of a web chat, as the shopper's session reads it. */
export interface WebChatMessageRecord {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  at: Date;
}

/** A session's token: 32 random bytes, in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (token: string) => createHash('sha256').update(token).digest();

type SettingsRow = { enabled: boolean; greeting: string | null; updated_at: string | Date };

async function settingsRowIn(tx: Tx, shopId: string): Promise<SettingsRow | undefined> {
  const { rows } = await tx.execute<SettingsRow>(sql`
    SELECT enabled, greeting, updated_at FROM messaging.web_chat_settings
     WHERE shop_id = ${shopId}`);
  return rows[0];
}

/** The shop's web chat while it is on, in the caller's transaction: its greeting; null while off. */
export async function webChatIn(
  tx: Tx,
  shopId: string,
): Promise<{ greeting: string | null } | null> {
  const row = await settingsRowIn(tx, shopId);
  return row?.enabled ? { greeting: row.greeting } : null;
}

/**
 * Web chat (MSG-10, ADR-810): shoppers write to the shop from its online store, giving their
 * name and mobile number to begin, and read its answers there. Each chat is the conversation of
 * that number on the web, in the shop's inbox beside WhatsApp's, which its staff answer from the
 * inbox as they answer WhatsApp. A browser holds the token of its own session, which reads only
 * what was written since it began: a number typed in shows no one what was said before.
 */
@Injectable()
export class WebChatService {
  constructor(private readonly db: Database) {}

  /** The shop's web chat, as set, or off where it never was. */
  async settings(tenant: TenantContext): Promise<WebChatSettingsRecord> {
    const row = await this.db.tenant(tenant.shopId, (tx) => settingsRowIn(tx, tenant.shopId));
    return {
      enabled: row?.enabled ?? false,
      greeting: row?.greeting ?? null,
      updatedAt: row ? toDate(row.updated_at) : null,
    };
  }

  /** Turns the shop's web chat on or off, or changes its greeting. */
  async update(
    tenant: TenantContext,
    input: WebChatSettingsInput,
  ): Promise<MutationResult<WebChatSettingsRecord>> {
    const current = await this.settings(tenant);
    let greeting = current.greeting;
    if (input.greeting !== undefined) {
      greeting = input.greeting?.trim() || null;
      if (greeting && greeting.length > WEB_CHAT_LIMITS.greeting) {
        return failOne(
          ['input', 'greeting'],
          'TOO_LONG',
          `Greet shoppers in ${WEB_CHAT_LIMITS.greeting} characters at most`,
        );
      }
    }
    const enabled = input.enabled ?? current.enabled;
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<SettingsRow>(sql`
        INSERT INTO messaging.web_chat_settings (shop_id, enabled, greeting)
        VALUES (${tenant.shopId}, ${enabled}, ${greeting})
        ON CONFLICT (shop_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, greeting = EXCLUDED.greeting, updated_at = now()
        RETURNING enabled, greeting, updated_at`);
      const actor = actorColumnsOf(tenant.actor);
      // The storefront shows the chat, or no longer does (ADR-810).
      await appendEvent<WebChatUpdatedPayload>(tx, tenant.shopId, {
        type: MessagingEvents.WebChatUpdated,
        aggregateType: 'shop',
        aggregateId: tenant.shopId,
        payload: { enabled, ...actor },
      });
      await recordAudit(tx, tenant.shopId, {
        action: MessagingEvents.WebChatUpdated,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { enabled, greeting },
      });
      const row = rows[0]!;
      return {
        ok: true,
        value: { enabled: row.enabled, greeting: row.greeting, updatedAt: toDate(row.updated_at) },
      };
    });
  }

  /**
   * Starts a chat: the shopper's name, mobile number and first message, while the shop's chat is
   * on. The session's token, given once, and its messages; null while the chat is off.
   */
  async start(
    shopId: string,
    input: { name?: string; phone?: string; body?: string },
    at: Date = new Date(),
  ): Promise<MutationResult<{ token: string; messages: WebChatMessageRecord[] }> | null> {
    const check = new InputChecker();
    const name = (input.name ?? '').trim();
    if (!name) check.addMessage(['name'], 'BLANK', 'Say your name');
    else if (name.length > WEB_CHAT_LIMITS.name) {
      check.addMessage(['name'], 'TOO_LONG', `Say your name in ${WEB_CHAT_LIMITS.name} characters`);
    }
    const phone = parsePkMobile(input.phone ?? '');
    if (!phone) {
      check.addMessage(['phone'], 'INVALID', 'Give a Pakistani mobile number, like 0300 1234567');
    }
    const body = checkBody(check, input.body);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(shopId, async (tx) => {
      if (!(await webChatIn(tx, shopId))) return null;
      const iso = at.toISOString();
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO messaging.conversations
               (shop_id, channel, customer_phone, customer_name, last_message_at)
        VALUES (${shopId}, 'web', ${phone!.e164}, ${name}, ${iso})
            ON CONFLICT (shop_id, channel, customer_phone) DO UPDATE
                   SET customer_name = excluded.customer_name
        RETURNING id`);
      const conversationId = rows[0]!.id;
      const token = randomBytes(32).toString('base64url');
      await tx.execute(sql`
        INSERT INTO messaging.web_chat_sessions
               (shop_id, token_hash, conversation_id, created_at, last_seen_at)
        VALUES (${shopId}, ${sha256(token)}, ${conversationId}, ${iso}, ${iso})`);
      await writeIn(tx, shopId, conversationId, body!, iso);
      return {
        ok: true,
        value: { token, messages: (await sessionMessagesIn(tx, shopId, token, at)) ?? [] },
      };
    });
  }

  /**
   * Another message of the session `token` names: its messages after; null for no session, or
   * while the chat is off.
   */
  async write(
    shopId: string,
    token: string,
    input: { body?: string },
    at: Date = new Date(),
  ): Promise<MutationResult<WebChatMessageRecord[]> | null> {
    if (!TOKEN.test(token)) return null;
    const check = new InputChecker();
    const body = checkBody(check, input.body);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(shopId, async (tx) => {
      const session = await sessionIn(tx, shopId, token);
      if (!session || !(await webChatIn(tx, shopId))) return null;
      const { rows } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messaging.conversation_messages
         WHERE shop_id = ${shopId} AND conversation_id = ${session.conversationId}
           AND direction = 'inbound' AND at > ${new Date(at.getTime() - 3_600_000).toISOString()}`);
      if (rows[0]!.count >= WEB_CHAT_LIMITS.perHour) {
        return failOne(
          ['body'],
          'TOO_MANY',
          'You have written a lot this hour: wait for the shop to answer',
        );
      }
      await writeIn(tx, shopId, session.conversationId, body!, at.toISOString());
      return { ok: true, value: (await sessionMessagesIn(tx, shopId, token, at))! };
    });
  }

  /**
   * The messages of the session `token` names, since it began: the shop's answers among them
   * read from now. Null for no session, or while the chat is off.
   */
  async read(
    shopId: string,
    token: string,
    at: Date = new Date(),
  ): Promise<WebChatMessageRecord[] | null> {
    if (!TOKEN.test(token)) return null;
    return this.db.tenant(shopId, async (tx) =>
      (await webChatIn(tx, shopId)) ? sessionMessagesIn(tx, shopId, token, at) : null,
    );
  }
}

/** A message's words, checked. */
function checkBody(check: InputChecker, given: string | undefined): string | null {
  const body = (given ?? '').trim();
  if (!body) check.addMessage(['body'], 'BLANK', 'Write your message');
  else if (body.length > WEB_CHAT_LIMITS.body) {
    check.addMessage(
      ['body'],
      'TOO_LONG',
      `Write ${WEB_CHAT_LIMITS.body.toLocaleString('en')} characters at most`,
    );
  } else return body;
  return null;
}

async function sessionIn(
  tx: Tx,
  shopId: string,
  token: string,
): Promise<{ conversationId: string; createdAt: string } | null> {
  const { rows } = await tx.execute<{ conversation_id: string; created_at: string }>(sql`
    SELECT conversation_id, created_at::text AS created_at FROM messaging.web_chat_sessions
     WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)}`);
  const row = rows[0];
  return row ? { conversationId: row.conversation_id, createdAt: row.created_at } : null;
}

/**
 * Keeps what the shopper wrote in their conversation, opening it again if it was closed, as a
 * message on WhatsApp is kept (ADR-545): unread, and waiting for an answer, which the shop's
 * staff hear of.
 */
async function writeIn(
  tx: Tx,
  shopId: string,
  conversationId: string,
  body: string,
  at: string,
): Promise<void> {
  const before = await tx.execute<{ waiting: boolean; assignee_id: string | null }>(sql`
    SELECT waiting_since IS NOT NULL AS waiting, assignee_id FROM messaging.conversations
     WHERE shop_id = ${shopId} AND id = ${conversationId}
       FOR UPDATE`);
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO messaging.conversation_messages
           (shop_id, conversation_id, direction, body, at)
    VALUES (${shopId}, ${conversationId}, 'inbound', ${body}, ${at})
    RETURNING id`);
  await tx.execute(sql`
    UPDATE messaging.conversations
       SET status = 'open', unread = unread + 1,
           waiting_since = coalesce(waiting_since, ${at}::timestamptz),
           last_message_at = greatest(last_message_at, ${at}::timestamptz),
           last_inbound_at = greatest(last_inbound_at, ${at}::timestamptz)
     WHERE shop_id = ${shopId} AND id = ${conversationId}`);
  await appendEvent<ConversationMessageReceivedPayload>(tx, shopId, {
    type: MessagingEvents.ConversationMessageReceived,
    aggregateType: 'conversation',
    aggregateId: conversationId,
    payload: {
      messageId: rows[0]!.id,
      at,
      startedWaiting: !before.rows[0]!.waiting,
      assigneeId: before.rows[0]!.assignee_id,
    },
  });
}

/**
 * The messages of the session `token` names since it began, the latest {@link
 * WEB_CHAT_LIMITS.read}, the oldest first; the shop's answers among them read, and the session
 * seen, at `at`. Null for no session.
 */
async function sessionMessagesIn(
  tx: Tx,
  shopId: string,
  token: string,
  at: Date,
): Promise<WebChatMessageRecord[] | null> {
  const session = await sessionIn(tx, shopId, token);
  if (!session) return null;
  await tx.execute(sql`
    UPDATE messaging.web_chat_sessions SET last_seen_at = ${at.toISOString()}
     WHERE shop_id = ${shopId} AND token_hash = ${sha256(token)}`);
  await tx.execute(sql`
    UPDATE messaging.conversation_messages SET status = 'read'
     WHERE shop_id = ${shopId} AND conversation_id = ${session.conversationId}
       AND direction = 'outbound' AND status IN ('sent', 'delivered')
       AND at >= ${session.createdAt}::timestamptz`);
  const { rows } = await tx.execute<{
    id: string;
    direction: 'inbound' | 'outbound';
    body: string;
    at: string | Date;
  }>(sql`
    SELECT id, direction, body, at FROM (
      SELECT id, direction, body, at FROM messaging.conversation_messages
       WHERE shop_id = ${shopId} AND conversation_id = ${session.conversationId}
         AND at >= ${session.createdAt}::timestamptz AND body IS NOT NULL
       ORDER BY at DESC, id DESC
       LIMIT ${WEB_CHAT_LIMITS.read}) latest
     ORDER BY at, id`);
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    body: row.body,
    at: toDate(row.at),
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const messagesJson = (messages: readonly WebChatMessageRecord[]): WebChatMessageJson[] =>
  messages.map((message) => ({
    id: toPublicId('conversationMessage', message.id),
    direction: message.direction,
    body: message.body,
    at: message.at.toISOString(),
  }));

const text = (body: unknown, name: string): string | undefined => {
  const given = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return typeof given[name] === 'string' ? given[name] : undefined;
};

function refused(errors: { field: string[]; message: string }[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    errors: errors.map(({ field, message }) => ({ field: field.join('.'), message })),
  } satisfies WebChatErrorResponse);
}

/**
 * Web chat, as storefronts send it on (ADR-810): `POST /storefront/shops/{shop}/web-chat` starts
 * one, `…/messages` writes in it and `…/read` reads it, the session's token in the body, never
 * the address. 404 while the shop's chat is off, or for a session that is none; 422 says what
 * was wrong. The host application checks the storefront key before any of this runs.
 */
@Controller(webChatPath(':shopId').slice(1))
export class StorefrontWebChatController {
  constructor(private readonly chat: WebChatService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async start(@Param('shopId') shopId: string, @Body() body: unknown): Promise<WebChatResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const result = await this.chat.start(shopId, {
      name: text(body, 'name'),
      phone: text(body, 'phone'),
      body: text(body, 'body'),
    });
    if (!result) throw new NotFoundException();
    if (!result.ok) throw refused(result.errors);
    return { token: result.value.token, messages: messagesJson(result.value.messages) };
  }

  @Post('messages')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async write(@Param('shopId') shopId: string, @Body() body: unknown): Promise<WebChatResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const result = await this.chat.write(shopId, text(body, 'token') ?? '', {
      body: text(body, 'body'),
    });
    if (!result) throw new NotFoundException();
    if (!result.ok) throw refused(result.errors);
    return { messages: messagesJson(result.value) };
  }

  @Post('read')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async read(@Param('shopId') shopId: string, @Body() body: unknown): Promise<WebChatResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const messages = await this.chat.read(shopId, text(body, 'token') ?? '');
    if (!messages) throw new NotFoundException();
    return { messages: messagesJson(messages) };
  }
}
