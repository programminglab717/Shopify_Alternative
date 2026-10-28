import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  generateAccessToken,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_LIMITS, checkScopes, generateWebhookSecret, sealedFor } from './apps.js';
import { AppEvents, type AppChangedPayload } from './events.js';

/** A custom app as the Admin API shows it: never its token or secret. */
export interface CustomAppRecord {
  id: string;
  name: string;
  scopes: string[];
  /** Its token's last four characters. */
  tokenHint: string;
  /** Its webhooks' secret's last four characters; null for an app made before it had one. */
  secretHint: string | null;
  /** The member of staff who made it, if one did. */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A custom app made, with what is shown once. */
export interface CustomAppCreated {
  app: CustomAppRecord;
  accessToken: string;
  webhookSecret: string;
}

export interface CustomAppInput {
  name?: string | null;
  scopes?: readonly string[] | null;
}

type AppRow = {
  id: string;
  name: string;
  scopes: string[];
  token_hint: string;
  secret_hint: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const COLUMNS = sql.raw(
  'id, name, scopes, token_hint, secret_hint, created_by, created_at, updated_at',
);

function toRecord(row: AppRow): CustomAppRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    tokenHint: row.token_hint,
    secretHint: row.secret_hint,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

async function appIn(tx: Tx, shopId: string, id: string): Promise<AppRow | null> {
  const { rows } = await tx.execute<AppRow>(sql`
    SELECT ${COLUMNS} FROM apps.access_tokens
     WHERE shop_id = ${shopId} AND id = ${id} AND revoked_at IS NULL
       AND public_app_id IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       FOR UPDATE`);
  return rows[0] ?? null;
}

const NOT_FOUND = 'No app of the shop has this ID';

/**
 * The shop's custom apps (DEV-04, ADR-395): each an Admin API access token with a name and the
 * scopes it may use, and a secret its webhooks are signed with. Owners and managers make them, the
 * Admin API checking who may; the token and the secret are shown once, the secret kept sealed for
 * the app alone, and either can be replaced. Removing an app revokes its token at once. Every
 * change is on the activity log and the audit log, never a token or a secret. A plan without
 * custom apps makes none, keeping those made before (ADR-523).
 */
@Injectable()
export class CustomAppService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  /** The shop's apps, the latest first; those removed or expired are not. */
  async list(tenant: TenantContext): Promise<CustomAppRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<AppRow>(sql`
        SELECT ${COLUMNS} FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND revoked_at IS NULL AND public_app_id IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at DESC, id DESC`),
    );
    return rows.map(toRecord);
  }

  /** Makes an app with a name and scopes the caller may give, its token and secret new. */
  async create(
    tenant: TenantContext,
    input: CustomAppInput,
  ): Promise<MutationResult<CustomAppCreated>> {
    const check = new InputChecker();
    const name = check.text(['input', 'name'], input.name, {
      required: true,
      max: APP_LIMITS.name,
    });
    const scopes = checkScopes(check, tenant, ['input', 'scopes'], input.scopes ?? []);
    if (!check.ok) return { ok: false, errors: check.errors };
    const plan = await this.allowance?.excludes(tenant.shopId, 'customApps');
    if (plan) {
      return failOne(['input'], 'INVALID', planFeatureMessage(plan, 'custom apps', 'make one'));
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND revoked_at IS NULL AND public_app_id IS NULL
           AND (expires_at IS NULL OR expires_at > now())`);
      if (rows[0]!.count >= APP_LIMITS.apps) {
        return failOne(
          ['input'],
          'TOO_MANY',
          `A shop keeps up to ${APP_LIMITS.apps} apps: remove one it no longer uses first`,
        );
      }
      const id = newId();
      const token = generateAccessToken();
      const secret = generateWebhookSecret();
      const actor = actorColumnsOf(tenant.actor);
      await tx.execute(sql`
        INSERT INTO apps.access_tokens
               (shop_id, id, name, token_hash, token_hint, scopes, webhook_secret, secret_hint,
                created_by)
        VALUES (${tenant.shopId}, ${id}, ${name!}, ${token.hash}, ${token.hint},
                ${sql.param(scopes!)}::text[],
                ${this.box.encrypt(secret.secret, sealedFor(tenant.shopId, id))}, ${secret.hint},
                ${actor.actorKind === 'staff' ? actor.actorId : null})`);
      const app = toRecord((await appIn(tx, tenant.shopId, id))!);
      await this.#record(tx, tenant, AppEvents.Created, app);
      return {
        ok: true,
        value: { app, accessToken: token.token, webhookSecret: secret.secret },
      };
    });
  }

  /** Renames an app or changes its scopes, from its next request on. */
  async update(
    tenant: TenantContext,
    id: string,
    input: CustomAppInput,
  ): Promise<MutationResult<CustomAppRecord>> {
    const check = new InputChecker();
    const name =
      input.name === undefined || input.name === null
        ? undefined
        : check.text(['input', 'name'], input.name, { required: true, max: APP_LIMITS.name });
    const scopes =
      input.scopes === undefined || input.scopes === null
        ? undefined
        : checkScopes(check, tenant, ['input', 'scopes'], input.scopes);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await appIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      const next = { name: name ?? current.name, scopes: scopes ?? current.scopes };
      const changed = [
        ...(next.name !== current.name ? ['name'] : []),
        ...(next.scopes.join(' ') !== current.scopes.join(' ') ? ['scopes'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: toRecord(current) };
      await tx.execute(sql`
        UPDATE apps.access_tokens
           SET name = ${next.name}, scopes = ${sql.param(next.scopes)}::text[], updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const app = toRecord((await appIn(tx, tenant.shopId, id))!);
      await this.#record(tx, tenant, AppEvents.Updated, app, {
        changed,
        before: { name: current.name, scopes: current.scopes },
      });
      return { ok: true, value: app };
    });
  }

  /** Gives an app a new token: the one it had stops working at once. */
  async rotateToken(
    tenant: TenantContext,
    id: string,
  ): Promise<MutationResult<{ app: CustomAppRecord; accessToken: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (!(await appIn(tx, tenant.shopId, id))) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      const token = generateAccessToken();
      await tx.execute(sql`
        UPDATE apps.access_tokens
           SET token_hash = ${token.hash}, token_hint = ${token.hint}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const app = toRecord((await appIn(tx, tenant.shopId, id))!);
      await this.#record(tx, tenant, AppEvents.TokenRotated, app);
      return { ok: true, value: { app, accessToken: token.token } };
    });
  }

  /** Gives an app a new secret for its webhooks, which are signed with it from now on. */
  async rotateSecret(
    tenant: TenantContext,
    id: string,
  ): Promise<MutationResult<{ app: CustomAppRecord; webhookSecret: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      if (!(await appIn(tx, tenant.shopId, id))) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      const secret = generateWebhookSecret();
      await tx.execute(sql`
        UPDATE apps.access_tokens
           SET webhook_secret = ${this.box.encrypt(secret.secret, sealedFor(tenant.shopId, id))},
               secret_hint = ${secret.hint}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const app = toRecord((await appIn(tx, tenant.shopId, id))!);
      await this.#record(tx, tenant, AppEvents.SecretRotated, app);
      return { ok: true, value: { app, webhookSecret: secret.secret } };
    });
  }

  /** Removes an app: its token is revoked at once. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<CustomAppRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await appIn(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', NOT_FOUND);
      await tx.execute(sql`
        UPDATE apps.access_tokens SET revoked_at = now(), updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      const app = toRecord(current);
      await this.#record(tx, tenant, AppEvents.Deleted, { ...app, scopes: [] });
      return { ok: true, value: app };
    });
  }

  /**
   * The secret an app's webhooks are signed with, opened; null for an app removed, or made before
   * apps had one. For the worker, which signs deliveries.
   */
  async webhookSecretOf(shopId: string, id: string): Promise<string | null> {
    const { rows } = await this.db.tenant(shopId, (tx) =>
      tx.execute<{ webhook_secret: string | null }>(sql`
        SELECT webhook_secret FROM apps.access_tokens
         WHERE shop_id = ${shopId} AND id = ${id} AND revoked_at IS NULL`),
    );
    const sealed = rows[0]?.webhook_secret;
    return sealed ? this.box.decrypt(sealed, sealedFor(shopId, id)).toString('utf8') : null;
  }

  async #record(
    tx: Tx,
    tenant: TenantContext,
    type: (typeof AppEvents)[keyof typeof AppEvents],
    app: CustomAppRecord,
    extra: { changed?: string[]; before?: { name: string; scopes: string[] } } = {},
  ): Promise<void> {
    await appendEvent<AppChangedPayload>(tx, tenant.shopId, {
      type,
      aggregateType: 'app',
      aggregateId: app.id,
      payload: {
        name: app.name,
        scopes: app.scopes,
        ...(extra.changed && { changed: extra.changed }),
      },
    });
    await recordAudit(tx, tenant.shopId, {
      action: type,
      subjectType: 'accessToken',
      subjectId: app.id,
      ...actorColumnsOf(tenant.actor),
      details: {
        name: app.name,
        scopes: app.scopes,
        tokenHint: app.tokenHint,
        secretHint: app.secretHint,
        ...extra,
      },
    });
  }
}
