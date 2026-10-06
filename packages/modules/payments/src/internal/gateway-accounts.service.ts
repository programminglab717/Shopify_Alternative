import {
  InputChecker,
  PublicSite,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  PaymentEvents,
  type GatewayAccountChangedPayload,
  type GatewayAccountsReorderedPayload,
} from './events.js';
import {
  GATEWAY_ENVIRONMENTS,
  PaymentGateways,
  type GatewayAccount,
  type GatewayCredentials,
  type GatewayEnvironmentValue,
  type PaymentGatewayInfo,
} from './gateways.js';

/** The gateways shops can take payments through here (ADR-151): the host application's. */
export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/** How long a credential may be. */
export const GATEWAY_ACCOUNT_LIMITS = { credential: 1_000 } as const;

/** Where gateways send their webhooks, under the account's ID. */
export const PAYMENT_WEBHOOK_PATH = 'webhooks/payments';

/** An account with a payment gateway, as the Admin API shows it: never its credentials. */
export interface GatewayAccountRecord {
  id: string;
  gateway: string;
  /** "Safepay". */
  gatewayName: string;
  environment: GatewayEnvironmentValue;
  /** The last four characters of its first credential, to tell accounts apart. */
  credentialsHint: string;
  /** Where the gateway sends its webhooks for the account, as its dashboard asks. */
  webhookUrl: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A credential, by the gateway's {@link GatewayCredentialField.key}. */
export interface GatewayCredentialInput {
  key: string;
  value: string;
}

export interface GatewayAccountInput {
  /** The gateway, such as "safepay"; connecting only. */
  gateway?: string | null;
  /** Production unless given. */
  environment?: GatewayEnvironmentValue | null;
  /** All the gateway asks for, all at once: replacing them replaces every one. */
  credentials?: readonly GatewayCredentialInput[] | null;
}

/** An account payments are taken through, its credentials opened. */
export interface OpenedGatewayAccount extends GatewayAccount {
  id: string;
  gateway: string;
  archived: boolean;
}

export type GatewayAccountRow = {
  id: string;
  gateway: string;
  environment: GatewayEnvironmentValue;
  credentials: string;
  credentials_hint: string;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const ACCOUNT_COLUMNS = sql.raw(
  'id, gateway, environment, credentials, credentials_hint, archived_at, created_at, updated_at',
);

/**
 * What an account's sealed credentials are bound to: they open for that shop's account alone, so
 * that none can be copied onto another.
 */
function sealedFor(shopId: string, accountId: string): string {
  return `payment-gateway-account:${shopId}:${accountId}`;
}

/**
 * The shop's accounts with payment gateways (PAY-01, ADR-151): the shop's own, so the money
 * settles to the shop and never passes through Hatti, its credentials kept sealed and never shown
 * again. One live account a gateway. An account is archived, never deleted, as its payments stay
 * recorded and its webhooks still heard. Changes are audited, credentials never.
 */
@Injectable()
export class GatewayAccountService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly site: PublicSite,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: PaymentGateways,
  ) {}

  /**
   * The shop's accounts, in the order its customers are offered them (ADR-221); archived ones, after
   * them, only if asked.
   */
  async list(
    tenant: TenantContext,
    options: { archived?: boolean } = {},
  ): Promise<GatewayAccountRecord[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<GatewayAccountRow>(sql`
        SELECT ${ACCOUNT_COLUMNS}
          FROM payments.gateway_accounts
         WHERE shop_id = ${tenant.shopId}
           ${options.archived ? sql`` : sql`AND archived_at IS NULL`}
         ORDER BY archived_at IS NOT NULL, position, created_at, id`);
      return rows.map((row) => this.#toRecord(row));
    });
  }

  async get(tenant: TenantContext, id: string): Promise<GatewayAccountRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) =>
      gatewayAccountIn(tx, tenant.shopId, id),
    );
    return row && this.#toRecord(row);
  }

  /**
   * Connects an account with a gateway: one live account a gateway, offered after the shop's
   * others.
   */
  async connect(
    tenant: TenantContext,
    input: GatewayAccountInput,
  ): Promise<MutationResult<GatewayAccountRecord>> {
    const check = new InputChecker();
    const gateway = input.gateway ? this.gateways.of(input.gateway.trim().toLowerCase()) : null;
    if (!gateway) {
      check.add(
        ['input', 'gateway'],
        input.gateway ? 'INVALID' : 'BLANK',
        `must be one of the gateways shops take payments through: ${this.gateways.list
          .map((each) => each.gateway)
          .join(', ')}`,
      );
    }
    const environment = checkEnvironment(check, input.environment) ?? 'production';
    const credentials = gateway
      ? this.#checkCredentials(check, gateway.info, input.credentials)
      : null;
    if (!check.ok || !gateway || !credentials) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const { rows: live } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM payments.gateway_accounts
         WHERE shop_id = ${tenant.shopId} AND gateway = ${gateway.info.gateway}
           AND archived_at IS NULL`);
      if (live.length > 0) {
        return failOne(
          ['input', 'gateway'],
          'TAKEN',
          `The shop has a ${gateway.info.name} account already: change it, or archive it first`,
        );
      }
      const id = newId();
      await tx.execute(sql`
        INSERT INTO payments.gateway_accounts (shop_id, id, gateway, environment, credentials,
                                               credentials_hint, position)
        SELECT ${tenant.shopId}, ${id}, ${gateway.info.gateway}, ${environment},
               ${this.#seal(tenant.shopId, id, credentials)}, ${hintOf(credentials)},
               coalesce(max(position), 0) + 1
          FROM payments.gateway_accounts
         WHERE shop_id = ${tenant.shopId}`);
      await this.#record(tx, tenant, id, PaymentEvents.GatewayAccountConnected, {
        gateway: gateway.info.gateway,
        environment,
      });
      return {
        ok: true,
        value: this.#toRecord((await gatewayAccountIn(tx, tenant.shopId, id))!),
      };
    });
  }

  /**
   * Changes what is given; fields left out stay as they are. A new environment needs its own
   * credentials: a gateway's sandbox and its real one have their own.
   */
  async update(
    tenant: TenantContext,
    id: string,
    input: GatewayAccountInput,
  ): Promise<MutationResult<GatewayAccountRecord>> {
    const check = new InputChecker();
    if (input.gateway !== undefined && input.gateway !== null) {
      check.add(['input', 'gateway'], 'INVALID', "can't change: connect another account instead");
    }
    const environment = checkEnvironment(check, input.environment);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const current = await gatewayAccountIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Payment gateway account not found');
      if (current.archived_at !== null) {
        return failOne(['id'], 'INVALID', 'The account is archived: connect it again instead');
      }
      const gateway = this.gateways.of(current.gateway);
      let credentials: GatewayCredentials | null = null;
      if (input.credentials !== undefined && input.credentials !== null) {
        if (!gateway) {
          return failOne(
            ['input', 'credentials'],
            'INVALID',
            'Shops no longer take payments through this gateway here',
          );
        }
        credentials = this.#checkCredentials(check, gateway.info, input.credentials);
        if (!check.ok || !credentials) return { ok: false, errors: check.errors };
      }
      const moved = environment !== null && environment !== current.environment;
      if (moved && !credentials) {
        return failOne(
          ['input', 'credentials'],
          'BLANK',
          `Give the account's credentials for its ${environment === 'sandbox' ? 'sandbox' : 'real environment'} too`,
        );
      }
      const opened = credentials && this.#open(tenant.shopId, current);
      const changed = [
        ...(moved ? ['environment'] : []),
        ...(credentials && !sameCredentials(credentials, opened) ? ['credentials'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: this.#toRecord(current) };
      await tx.execute(sql`
        UPDATE payments.gateway_accounts
           SET environment = ${environment ?? current.environment},
               credentials = ${credentials ? this.#seal(tenant.shopId, id, credentials) : current.credentials},
               credentials_hint = ${credentials ? hintOf(credentials) : current.credentials_hint},
               version = version + 1, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      await this.#record(tx, tenant, id, PaymentEvents.GatewayAccountUpdated, {
        gateway: current.gateway,
        environment: environment ?? current.environment,
        changed,
      });
      return {
        ok: true,
        value: this.#toRecord((await gatewayAccountIn(tx, tenant.shopId, id))!),
      };
    });
  }

  /**
   * Archives the account: no new payments through it. Payments its customers started still count
   * once its gateway says they are made, as the money is the shop's.
   */
  async archive(tenant: TenantContext, id: string): Promise<MutationResult<GatewayAccountRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const current = await gatewayAccountIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Payment gateway account not found');
      if (current.archived_at !== null) return { ok: true, value: this.#toRecord(current) };
      await tx.execute(sql`
        UPDATE payments.gateway_accounts
           SET archived_at = now(), version = version + 1, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      await this.#record(tx, tenant, id, PaymentEvents.GatewayAccountArchived, {
        gateway: current.gateway,
        environment: current.environment,
      });
      return {
        ok: true,
        value: this.#toRecord((await gatewayAccountIn(tx, tenant.shopId, id))!),
      };
    });
  }

  /**
   * Puts the shop's live accounts in the order its customers are offered them (PAY-05, ADR-221):
   * `ids` names each of them once, the first offered first. An account connected later goes last.
   */
  async reorder(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<MutationResult<GatewayAccountRecord[]>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await lockAccounts(tx, tenant.shopId);
      const live = await liveGatewayAccountsIn(tx, tenant.shopId);
      if (ids.length > live.length) {
        return failOne(
          ['ids'],
          'TOO_MANY',
          `List each of the shop's live accounts once: it has ${live.length}`,
        );
      }
      const check = new InputChecker();
      const given = new Set<string>();
      for (const [index, id] of ids.entries()) {
        if (given.has(id)) {
          check.addMessage(['ids', String(index)], 'INVALID', 'The account is listed twice');
        } else if (!live.some((row) => row.id === id)) {
          check.addMessage(
            ['ids', String(index)],
            'NOT_FOUND',
            'Payment gateway account not found among the live ones',
          );
        }
        given.add(id);
      }
      const missing = live.filter((row) => !given.has(row.id));
      if (check.ok && missing.length > 0) {
        check.addMessage(
          ['ids'],
          'INVALID',
          `List each of the shop's live accounts: ${missing
            .map((row) => this.#nameOf(row.gateway))
            .join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
        );
      }
      if (!check.ok) return { ok: false, errors: check.errors };
      const order = live.map((row) => row.id);
      if (ids.every((id, index) => order[index] === id)) {
        return { ok: true, value: live.map((row) => this.#toRecord(row)) };
      }
      await tx.execute(sql`
        UPDATE payments.gateway_accounts a
           SET position = given.position, version = a.version + 1, updated_at = now()
          FROM unnest(${sql.param(ids)}::uuid[]) WITH ORDINALITY AS given (id, position)
         WHERE a.shop_id = ${tenant.shopId} AND a.id = given.id
           AND a.position IS DISTINCT FROM given.position`);
      const actor = actorColumnsOf(tenant.actor);
      const gateways = ids.map((id) => live.find((row) => row.id === id)!.gateway);
      await appendEvent<GatewayAccountsReorderedPayload>(tx, tenant.shopId, {
        type: PaymentEvents.GatewayAccountsReordered,
        aggregateType: 'shop',
        aggregateId: tenant.shopId,
        payload: { gateways, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: PaymentEvents.GatewayAccountsReordered,
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { before: live.map((row) => row.gateway), after: gateways },
      });
      const reordered = await liveGatewayAccountsIn(tx, tenant.shopId);
      return { ok: true, value: reordered.map((row) => this.#toRecord(row)) };
    });
  }

  /** The account `row` is, of the shop `shopId`, its credentials opened. */
  openedIn(shopId: string, row: GatewayAccountRow): OpenedGatewayAccount {
    return {
      id: row.id,
      gateway: row.gateway,
      environment: row.environment,
      credentials: this.#open(shopId, row),
      archived: row.archived_at !== null,
    };
  }

  /** Where the gateway sends the account's webhooks. */
  webhookUrl(id: string): string {
    return this.site.url(`${PAYMENT_WEBHOOK_PATH}/${toPublicId('paymentGatewayAccount', id)}`);
  }

  /** What the gateway asks for, all of it, each once, as it was typed but trimmed. */
  #checkCredentials(
    check: InputChecker,
    gateway: PaymentGatewayInfo,
    given: readonly GatewayCredentialInput[] | null | undefined,
  ): GatewayCredentials | null {
    const field = ['input', 'credentials'];
    const values = new Map<string, string>();
    for (const [index, credential] of (given ?? []).entries()) {
      const spec = gateway.credentials.find((each) => each.key === credential.key);
      const known = spec !== undefined;
      if (!known || values.has(credential.key)) {
        check.add(
          [...field, String(index), 'key'],
          'INVALID',
          known
            ? 'is given twice'
            : `must be one of ${gateway.credentials.map((each) => each.key).join(', ')}`,
        );
        continue;
      }
      // As the gateway keeps it, as a key loses its PEM armour (ADR-229).
      const value = (spec.normalize ?? ((text: string) => text))(credential.value.trim());
      if (
        value === '' ||
        value.length > (spec.maxLength ?? GATEWAY_ACCOUNT_LIMITS.credential) ||
        !/^[!-~]+$/.test(value)
      ) {
        check.add(
          [...field, String(index), 'value'],
          'INVALID',
          'must be as the gateway gave it: letters, digits and marks, without spaces',
        );
        continue;
      }
      // In the one shape the gateway gives it, where it has one, as Easypaisa's hash key.
      if (spec.pattern && !spec.pattern.test(value)) {
        check.add(
          [...field, String(index), 'value'],
          'INVALID',
          spec.problem ?? 'must be as the gateway gave it',
        );
        continue;
      }
      values.set(credential.key, value);
    }
    const missing = gateway.credentials.filter((each) => !values.has(each.key));
    if (missing.length > 0) {
      check.addMessage(
        field,
        'BLANK',
        `${gateway.name} needs its ${missing.map((each) => each.label).join(' and ')}`,
      );
    }
    // In the order the gateway asks for them: the first gives the hint.
    return check.ok
      ? Object.fromEntries(gateway.credentials.map((each) => [each.key, values.get(each.key)!]))
      : null;
  }

  #seal(shopId: string, id: string, credentials: GatewayCredentials): string {
    return this.box.encrypt(JSON.stringify(credentials), sealedFor(shopId, id));
  }

  #open(shopId: string, row: GatewayAccountRow): GatewayCredentials {
    return JSON.parse(
      this.box.decrypt(row.credentials, sealedFor(shopId, row.id)).toString('utf8'),
    ) as GatewayCredentials;
  }

  async #record(
    tx: Tx,
    tenant: TenantContext,
    id: string,
    type: string,
    payload: Omit<GatewayAccountChangedPayload, 'actorKind' | 'actorId'>,
  ): Promise<void> {
    const actor = actorColumnsOf(tenant.actor);
    await appendEvent<GatewayAccountChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'payment_gateway_account',
      aggregateId: id,
      payload: { ...payload, actorKind: actor.actorKind, actorId: actor.actorId },
    });
    const row = (await gatewayAccountIn(tx, tenant.shopId, id))!;
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'paymentGatewayAccount',
      subjectId: id,
      ...actor,
      details: { ...payload, credentialsHint: row.credentials_hint },
    });
  }

  #nameOf(gateway: string): string {
    return this.gateways.of(gateway)?.info.name ?? gateway;
  }

  #toRecord(row: GatewayAccountRow): GatewayAccountRecord {
    return {
      id: row.id,
      gateway: row.gateway,
      gatewayName: this.#nameOf(row.gateway),
      environment: row.environment,
      credentialsHint: row.credentials_hint,
      webhookUrl: this.webhookUrl(row.id),
      archivedAt: row.archived_at === null ? null : toDate(row.archived_at),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    };
  }
}

/** One change to the shop's accounts at a time: one live account a gateway. */
async function lockAccounts(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment_gateway_accounts:${shopId}`}, 0))`,
  );
}

export async function gatewayAccountIn(
  tx: Tx,
  shopId: string,
  id: string,
): Promise<GatewayAccountRow | null> {
  const { rows } = await tx.execute<GatewayAccountRow>(sql`
    SELECT ${ACCOUNT_COLUMNS}
      FROM payments.gateway_accounts
     WHERE shop_id = ${shopId} AND id = ${id}`);
  return rows[0] ?? null;
}

/**
 * The accounts the shop takes payments through now, for customers to choose among (ADR-219): its
 * live ones, one a gateway, in the order it puts them, else that it connected them in (ADR-221).
 */
export async function liveGatewayAccountsIn(tx: Tx, shopId: string): Promise<GatewayAccountRow[]> {
  const { rows } = await tx.execute<GatewayAccountRow>(sql`
    SELECT ${ACCOUNT_COLUMNS}
      FROM payments.gateway_accounts
     WHERE shop_id = ${shopId} AND archived_at IS NULL
     ORDER BY position, created_at, id`);
  return rows;
}

/**
 * How many of the shop's live accounts take real money (ADR-232), in the caller's transaction
 * `tx`: those in their gateway's production, the test gateway's aside, which takes none.
 */
export async function realGatewayAccountsIn(tx: Tx, shopId: string): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM payments.gateway_accounts
     WHERE shop_id = ${shopId} AND archived_at IS NULL
       AND environment = 'production' AND gateway <> 'test'`);
  return rows[0]?.count ?? 0;
}

function checkEnvironment(
  check: InputChecker,
  given: string | null | undefined,
): GatewayEnvironmentValue | null {
  if (given === undefined || given === null) return null;
  if ((GATEWAY_ENVIRONMENTS as readonly string[]).includes(given)) {
    return given as GatewayEnvironmentValue;
  }
  check.add(
    ['input', 'environment'],
    'INVALID',
    `must be one of ${GATEWAY_ENVIRONMENTS.join(', ')}`,
  );
  return null;
}

/** The last four characters of the first credential the gateway asks for. */
function hintOf(credentials: GatewayCredentials): string {
  return (Object.values(credentials)[0] ?? '').slice(-4);
}

function sameCredentials(a: GatewayCredentials, b: GatewayCredentials | null): boolean {
  if (!b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
