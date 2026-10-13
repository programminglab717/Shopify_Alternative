import 'reflect-metadata';
import {
  AccessTokenAuthenticator,
  ROLE_SCOPES,
  type MutationResult,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_LIMITS, WEBHOOK_SECRET_PREFIX } from './apps.js';
import { CustomAppService } from './custom-apps.service.js';

const server = testDatabaseServer();

function staff(shopId: string, role: StaffRole): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    scopes: new Set(ROLE_SCOPES[role]),
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      role,
      authenticatedAt: new Date(),
    },
  };
}

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Refused: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function refusals<T>(result: MutationResult<T>) {
  return result.ok ? [] : result.errors.map((error) => [error.field, error.code]);
}

describe.skipIf(!server)('Custom apps (DEV-04, ADR-395)', () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let service: CustomAppService;
  let tokens: AccessTokenAuthenticator;
  const shopA = newId();
  const shopB = newId();
  const owner = staff(shopA, 'owner');

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({ appUrl: testDb.appUrl, applicationName: 'apps-test' });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
      shopA,
      shopB,
    ]);
    service = new CustomAppService(db, SecretBox.fromString(`k1:${SecretBox.generateKey()}`));
    tokens = new AccessTokenAuthenticator(db.app);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM apps.access_tokens; DELETE FROM platform.outbox_events; ' +
        'DELETE FROM platform.audit_log',
    );
  });

  it('is made with the scopes its maker may give, its token working and its secret sealed', async () => {
    const made = unwrap(
      await service.create(owner, {
        name: '  Accounting sync ',
        scopes: ['write_orders', 'read_products', 'read_orders', 'WRITE_ORDERS'],
      }),
    );
    expect(made.app).toMatchObject({
      name: 'Accounting sync',
      // Each once, in the API's order.
      scopes: ['read_products', 'read_orders', 'write_orders'],
      tokenHint: made.accessToken.slice(-4),
      secretHint: made.webhookSecret.slice(-4),
      createdBy: (owner.actor as { userId: string }).userId,
    });
    expect(made.webhookSecret).toMatch(new RegExp(`^${WEBHOOK_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`));

    // Its token is an app acting for the shop, with those scopes.
    const context = await tokens.authenticate(made.accessToken);
    expect(context).toMatchObject({ shopId: shopA, actor: { kind: 'app', tokenId: made.app.id } });
    expect([...context!.scopes]).toEqual(['read_products', 'read_orders', 'write_orders']);

    // The secret is kept sealed, and opens for the worker.
    const { rows } = await admin.query<{ webhook_secret: string }>(
      'SELECT webhook_secret FROM apps.access_tokens',
    );
    expect(rows[0]!.webhook_secret).not.toContain(made.webhookSecret.slice(4, 20));
    expect(await service.webhookSecretOf(shopA, made.app.id)).toBe(made.webhookSecret);
    expect(await service.webhookSecretOf(shopB, made.app.id)).toBeNull();

    expect(await service.list(owner)).toEqual([made.app]);
    expect(await service.list(staff(shopB, 'owner'))).toEqual([]);
    const outbox = await admin.query('SELECT event_type, payload FROM platform.outbox_events');
    expect(outbox.rows).toEqual([
      {
        event_type: 'app.created',
        payload: {
          name: 'Accounting sync',
          scopes: ['read_products', 'read_orders', 'write_orders'],
        },
      },
    ]);
    const audit = await admin.query<{ action: string; details: Record<string, unknown> }>(
      'SELECT action, details FROM platform.audit_log',
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0])).not.toContain(made.accessToken);
    expect(JSON.stringify(audit.rows[0])).not.toContain(made.webhookSecret);
  });

  it('refuses a name or scopes it cannot have, and more apps than a shop keeps', async () => {
    expect(refusals(await service.create(owner, { name: ' ', scopes: [] }))).toEqual([
      [['input', 'name'], 'BLANK'],
      [['input', 'scopes'], 'BLANK'],
    ]);
    expect(
      refusals(await service.create(owner, { name: 'X', scopes: ['read_everything'] })),
    ).toEqual([[['input', 'scopes'], 'INVALID']]);
    // A marketer gives no more than a marketer may do.
    const marketer = staff(shopA, 'marketer');
    expect(
      refusals(await service.create(marketer, { name: 'X', scopes: ['write_orders'] })),
    ).toEqual([[['input', 'scopes'], 'INVALID']]);
    unwrap(await service.create(marketer, { name: 'X', scopes: ['read_orders'] }));

    for (let index = 1; index < APP_LIMITS.apps; index += 1) {
      unwrap(await service.create(owner, { name: `App ${index}`, scopes: ['read_products'] }));
    }
    expect(
      refusals(await service.create(owner, { name: 'One too many', scopes: ['read_products'] })),
    ).toEqual([[['input'], 'TOO_MANY']]);
  });

  it('is renamed, its scopes changed, given a new token or secret, and removed', async () => {
    const made = unwrap(
      await service.create(owner, { name: 'Sheet sync', scopes: ['read_orders'] }),
    );
    const changed = unwrap(
      await service.update(owner, made.app.id, { name: 'Orders sheet', scopes: ['write_orders'] }),
    );
    expect(changed).toMatchObject({ name: 'Orders sheet', scopes: ['write_orders'] });
    expect([...(await tokens.authenticate(made.accessToken))!.scopes]).toEqual(['write_orders']);
    // The same again changes nothing.
    unwrap(await service.update(owner, made.app.id, { name: 'Orders sheet' }));

    const rotated = unwrap(await service.rotateToken(owner, made.app.id));
    expect(await tokens.authenticate(made.accessToken)).toBeNull();
    expect((await tokens.authenticate(rotated.accessToken))!.shopId).toBe(shopA);
    expect(rotated.app.tokenHint).toBe(rotated.accessToken.slice(-4));

    const secret = unwrap(await service.rotateSecret(owner, made.app.id));
    expect(secret.webhookSecret).not.toBe(made.webhookSecret);
    expect(await service.webhookSecretOf(shopA, made.app.id)).toBe(secret.webhookSecret);

    // Another shop's app is none of this one's.
    const other = staff(shopB, 'owner');
    expect(refusals(await service.update(other, made.app.id, { name: 'Mine' }))).toEqual([
      [['id'], 'NOT_FOUND'],
    ]);
    expect(refusals(await service.delete(other, made.app.id))).toEqual([[['id'], 'NOT_FOUND']]);

    unwrap(await service.delete(owner, made.app.id));
    expect(await tokens.authenticate(rotated.accessToken)).toBeNull();
    expect(await service.list(owner)).toEqual([]);
    expect(await service.webhookSecretOf(shopA, made.app.id)).toBeNull();
    expect(refusals(await service.rotateToken(owner, made.app.id))).toEqual([
      [['id'], 'NOT_FOUND'],
    ]);
    const outbox = await admin.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_events ORDER BY id',
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual([
      'app.created',
      'app.updated',
      'app.token_rotated',
      'app.secret_rotated',
      'app.deleted',
    ]);
  });

  it('lists a token made before apps had a secret, without one', async () => {
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'Development token', $2, 'abcd', '{read_products}')`,
      [shopA, Buffer.alloc(32, 1)],
    );
    const [app] = await service.list(owner);
    expect(app).toMatchObject({ name: 'Development token', secretHint: null, createdBy: null });
    expect(await service.webhookSecretOf(shopA, app!.id)).toBeNull();
    const secret = unwrap(await service.rotateSecret(owner, app!.id));
    expect(await service.webhookSecretOf(shopA, app!.id)).toBe(secret.webhookSecret);
  });
});
