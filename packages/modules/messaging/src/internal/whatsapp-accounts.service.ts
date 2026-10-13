import { randomInt } from 'node:crypto';
import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, isUniqueViolation, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MessagingEvents,
  type WhatsAppAccountConnectedPayload,
  type WhatsAppAccountDisconnectedPayload,
} from './events.js';
import {
  WhatsAppBusinessClient,
  type WhatsAppQuality,
  type WhatsAppSignupSettings,
} from './whatsapp-business.js';

export const WHATSAPP_SIGNUP = Symbol('WHATSAPP_SIGNUP');

/** The shop's own WhatsApp number, as the Admin API shows it: never its token or PIN. */
export interface WhatsAppAccountRecord {
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: WhatsAppQuality;
  connectedAt: Date;
}

/** What Embedded Signup gave the admin, which it hands the core to connect the number. */
export interface WhatsAppAccountConnectInput {
  code: string;
  businessAccountId: string;
  phoneNumberId: string;
}

/** What the admin starts Embedded Signup with; nothing secret. */
export interface WhatsAppSignupRecord {
  appId: string;
  configurationId: string;
  graphVersion: string;
}

/** The shop's number as the worker sends from it, its token opened. */
export interface WhatsAppSender {
  phoneNumberId: string;
  accessToken: string;
}

type AccountRow = {
  business_account_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: WhatsAppQuality;
  access_token: string;
  created_at: string | Date;
};

const GRAPH_ID = /^[0-9]{1,30}$/;

/** What the shop's sealed token and PIN are bound to: they open for that shop alone. */
function sealedFor(shopId: string, what: 'token' | 'pin'): string {
  return `whatsapp-account:${what}:${shopId}`;
}

/**
 * A shop's own WhatsApp number (MKT-01, ADR-419), connected through Meta's Embedded Signup with
 * Hatti as the Tech Provider: the code the admin was given is exchanged for a business token,
 * the number is checked to be the shared account's, Hatti's app is subscribed to the account's
 * webhooks, and the number is registered to send with a PIN of Hatti's. The token and PIN are
 * kept sealed for the shop, never shown. A number sends for one shop at a time. Connecting and
 * disconnecting are audited and are events.
 */
@Injectable()
export class WhatsAppAccountsService {
  readonly #client: WhatsAppBusinessClient | null;

  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Inject(WHATSAPP_SIGNUP) private readonly signupSettings: WhatsAppSignupSettings | null,
  ) {
    this.#client = signupSettings && new WhatsAppBusinessClient(signupSettings);
  }

  /** What the admin starts Embedded Signup with; null where this server has none set up. */
  signup(): WhatsAppSignupRecord | null {
    const settings = this.signupSettings;
    return (
      settings && {
        appId: settings.appId,
        configurationId: settings.configurationId,
        graphVersion: settings.version,
      }
    );
  }

  async get(tenant: TenantContext): Promise<WhatsAppAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => accountIn(tx, tenant.shopId));
    return row && toRecord(row);
  }

  /**
   * Connects the number Embedded Signup shared, in place of any the shop had. Meta is asked
   * before anything is kept: a step it refuses is the shop's to try again.
   */
  async connect(
    tenant: TenantContext,
    input: WhatsAppAccountConnectInput,
  ): Promise<MutationResult<WhatsAppAccountRecord>> {
    const check = new InputChecker();
    const code = input.code.trim();
    if (!code) check.addMessage(['input', 'code'], 'BLANK', 'The sign-up gave no code');
    else if (code.length > 1_000)
      check.addMessage(['input', 'code'], 'TOO_LONG', 'The code is too long');
    for (const field of ['businessAccountId', 'phoneNumberId'] as const) {
      if (!GRAPH_ID.test(input[field])) {
        check.addMessage(
          ['input', field],
          'INVALID',
          `Not one of Meta's IDs: ${input[field].slice(0, 40)}`,
        );
      }
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const client = this.#client;
    if (!client) {
      return failOne(['input'], 'UNAVAILABLE', "Connecting WhatsApp isn't set up on this server");
    }

    const token = await client.exchangeCode(code);
    if (!token.ok) return failOne(['input', 'code'], 'INVALID', token.error);
    const numbers = await client.numbersOf(token.value, input.businessAccountId);
    if (!numbers.ok) return failOne(['input', 'businessAccountId'], 'INVALID', numbers.error);
    const number = numbers.value.find((each) => each.id === input.phoneNumberId);
    if (!number) {
      return failOne(
        ['input', 'phoneNumberId'],
        'NOT_FOUND',
        'The number is not one of the WhatsApp Business Account shared',
      );
    }
    const subscribed = await client.subscribe(token.value, input.businessAccountId);
    if (!subscribed.ok) return failOne(['input'], 'UNAVAILABLE', subscribed.error);
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const registered = await client.register(token.value, number.id, pin);
    if (!registered.ok) return failOne(['input', 'phoneNumberId'], 'INVALID', registered.error);

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const before = await accountIn(tx, tenant.shopId, { lock: true });
        await tx.execute(sql`
          INSERT INTO messaging.whatsapp_accounts
                 (shop_id, business_account_id, phone_number_id, display_phone_number,
                  verified_name, quality_rating, access_token, pin)
          VALUES (${tenant.shopId}, ${input.businessAccountId}, ${number.id},
                  ${number.displayPhoneNumber}, ${number.verifiedName}, ${number.qualityRating},
                  ${this.box.encrypt(token.value, sealedFor(tenant.shopId, 'token'))},
                  ${this.box.encrypt(pin, sealedFor(tenant.shopId, 'pin'))})
              ON CONFLICT (shop_id) DO UPDATE
                     SET business_account_id = excluded.business_account_id,
                         phone_number_id = excluded.phone_number_id,
                         display_phone_number = excluded.display_phone_number,
                         verified_name = excluded.verified_name,
                         quality_rating = excluded.quality_rating,
                         access_token = excluded.access_token, pin = excluded.pin,
                         version = messaging.whatsapp_accounts.version + 1,
                         created_at = now(), updated_at = now()`);
        const actor = actorColumnsOf(tenant.actor);
        await appendEvent<WhatsAppAccountConnectedPayload>(tx, tenant.shopId, {
          type: MessagingEvents.WhatsAppAccountConnected,
          aggregateType: 'whatsapp_account',
          aggregateId: tenant.shopId,
          payload: {
            phoneNumberId: number.id,
            actorKind: actor.actorKind,
            actorId: actor.actorId,
          },
        });
        await recordAudit(tx, tenant.shopId, {
          action: 'whatsapp_account.connected',
          subjectType: 'shop',
          subjectId: tenant.shopId,
          ...actor,
          details: {
            businessAccountId: input.businessAccountId,
            phoneNumberId: number.id,
            displayPhoneNumber: number.displayPhoneNumber,
            verifiedName: number.verifiedName,
            before: before && {
              phoneNumberId: before.phone_number_id,
              displayPhoneNumber: before.display_phone_number,
            },
          },
        });
        return { ok: true, value: toRecord((await accountIn(tx, tenant.shopId))!) };
      });
    } catch (error) {
      if (!isUniqueViolation(error, 'whatsapp_accounts_number')) throw error;
      return failOne(
        ['input', 'phoneNumberId'],
        'TAKEN',
        'This number is connected to another shop on Hatti',
      );
    }
  }

  /**
   * Disconnects the shop's number: its token and PIN are forgotten, and Hatti's app stops
   * hearing the account, as far as Meta still lets it. The number it had, or null.
   */
  async disconnect(tenant: TenantContext): Promise<string | null> {
    const gone = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<AccountRow>(sql`
        DELETE FROM messaging.whatsapp_accounts WHERE shop_id = ${tenant.shopId}
        RETURNING business_account_id, phone_number_id, display_phone_number, access_token`);
      const row = rows[0];
      if (!row) return null;
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<WhatsAppAccountDisconnectedPayload>(tx, tenant.shopId, {
        type: MessagingEvents.WhatsAppAccountDisconnected,
        aggregateType: 'whatsapp_account',
        aggregateId: tenant.shopId,
        payload: {
          phoneNumberId: row.phone_number_id,
          actorKind: actor.actorKind,
          actorId: actor.actorId,
        },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'whatsapp_account.disconnected',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          businessAccountId: row.business_account_id,
          phoneNumberId: row.phone_number_id,
          displayPhoneNumber: row.display_phone_number,
        },
      });
      return row;
    });
    if (!gone) return null;
    // Best done: a token the shop revoked in Meta already stops the webhooks.
    await this.#client?.unsubscribe(
      this.box.decrypt(gone.access_token, sealedFor(tenant.shopId, 'token')).toString('utf8'),
      gone.business_account_id,
    );
    return gone.display_phone_number;
  }

  /** The shop's number as the worker sends from it, its token opened; null if none. */
  async senderOf(shopId: string): Promise<WhatsAppSender | null> {
    const row = await this.db.tenant(shopId, (tx) => accountIn(tx, shopId));
    return (
      row && {
        phoneNumberId: row.phone_number_id,
        accessToken: this.box
          .decrypt(row.access_token, sealedFor(shopId, 'token'))
          .toString('utf8'),
      }
    );
  }
}

async function accountIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<AccountRow | null> {
  const { rows } = await tx.execute<AccountRow>(sql`
    SELECT business_account_id, phone_number_id, display_phone_number, verified_name,
           quality_rating, access_token, created_at
      FROM messaging.whatsapp_accounts WHERE shop_id = ${shopId}
      ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toRecord(row: AccountRow): WhatsAppAccountRecord {
  return {
    businessAccountId: row.business_account_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    qualityRating: row.quality_rating,
    connectedAt: toDate(row.created_at),
  };
}
