import { failOne, generateAccessToken, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { sealedFor } from './apps.js';
import { AppEvents, type AppChangedPayload } from './events.js';

// Public apps installed on a shop (DEV-05, ADR-851): once its owner or a manager approves an app
// and the app trades the code (identity's PartnerAppsService), the app is given a token of the
// shop's, as a custom app is (ADR-395), with the scopes approved. Its webhooks are signed with its
// client secret, which the app proved it holds, kept sealed for this shop and install. An app
// installed again replaces its install; uninstalled, its token stops working.

/** An app installed on the shop, as the Admin API shows it. */
export interface InstalledAppRecord {
  id: string;
  /** The registered app's own ID. */
  publicAppId: string;
  name: string;
  scopes: string[];
  installedAt: Date;
}

type InstallRow = {
  id: string;
  public_app_id: string;
  name: string;
  scopes: string[];
  created_at: Date | string;
};

const toRecord = (row: InstallRow): InstalledAppRecord => ({
  id: row.id,
  publicAppId: row.public_app_id,
  name: row.name,
  scopes: row.scopes,
  installedAt: toDate(row.created_at),
});

@Injectable()
export class AppInstallsService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  /**
   * Installs the app on the shop with `scopes`: its new token, given this once, the install it
   * had before revoked.
   */
  async install(
    shopId: string,
    app: { publicAppId: string; name: string; scopes: readonly string[]; clientSecret: string },
  ): Promise<{ install: InstalledAppRecord; accessToken: string }> {
    const token = generateAccessToken();
    const id = newId();
    return this.db.tenant(shopId, async (tx) => {
      await tx.execute(sql`
        UPDATE apps.access_tokens SET revoked_at = now(), updated_at = now()
         WHERE shop_id = ${shopId} AND public_app_id = ${app.publicAppId}
           AND revoked_at IS NULL`);
      const { rows } = await tx.execute<InstallRow>(sql`
        INSERT INTO apps.access_tokens
               (shop_id, id, name, token_hash, token_hint, scopes, webhook_secret, secret_hint,
                public_app_id)
        VALUES (${shopId}, ${id}, ${app.name.slice(0, 100)}, ${token.hash}, ${token.hint},
                ${sql.param([...app.scopes])}::text[],
                ${this.box.encrypt(app.clientSecret, sealedFor(shopId, id))},
                ${app.clientSecret.slice(-4)}, ${app.publicAppId})
        RETURNING id, public_app_id, name, scopes, created_at`);
      await appendEvent<AppChangedPayload>(tx, shopId, {
        type: AppEvents.Installed,
        aggregateType: 'app',
        aggregateId: id,
        payload: { name: app.name, scopes: [...app.scopes] },
      });
      return { install: toRecord(rows[0]!), accessToken: token.token };
    });
  }

  /** The apps installed on the shop, the latest first. */
  async installed(tenant: TenantContext): Promise<InstalledAppRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<InstallRow>(sql`
        SELECT id, public_app_id, name, scopes, created_at FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND public_app_id IS NOT NULL AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`),
    );
    return rows.map(toRecord);
  }

  /**
   * What an embedded app's session token is signed with (ADR-852): the installed app `id`'s
   * registered ID and its client secret, unsealed; null for none installed.
   */
  async sessionKeyOf(
    tenant: TenantContext,
    id: string,
  ): Promise<{ publicAppId: string; name: string; secret: string } | null> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ public_app_id: string; name: string; webhook_secret: string }>(sql`
        SELECT public_app_id, name, webhook_secret FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND id = ${id} AND public_app_id IS NOT NULL
           AND revoked_at IS NULL`),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      publicAppId: row.public_app_id,
      name: row.name,
      secret: this.box.decrypt(row.webhook_secret, sealedFor(tenant.shopId, id)).toString('utf8'),
    };
  }

  /** Uninstalls the app `id`: its token stops working at once. */
  async uninstall(tenant: TenantContext, id: string): Promise<MutationResult<InstalledAppRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<InstallRow>(sql`
        UPDATE apps.access_tokens SET revoked_at = now(), updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id} AND public_app_id IS NOT NULL
           AND revoked_at IS NULL
        RETURNING id, public_app_id, name, scopes, created_at`);
      const install = rows[0];
      if (!install) return failOne(['id'], 'NOT_FOUND', 'No such app is installed');
      await appendEvent<AppChangedPayload>(tx, tenant.shopId, {
        type: AppEvents.Uninstalled,
        aggregateType: 'app',
        aggregateId: id,
        payload: { name: install.name, scopes: [] },
      });
      return { ok: true, value: toRecord(install) };
    });
  }
}
