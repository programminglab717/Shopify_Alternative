import { Database } from '@hatti/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { shopClasses, shopUuid } from './dataset.js';
import { rootMessage } from './service.js';
import type { Path, Settings } from './settings.js';

class IntendedRollback extends Error {}

export interface LeakCheckResult {
  path: Path;
  clients: number;
  seconds: number;
  transactions: number;
  /** Transactions ended by an error: half thrown by the caller, half by a failing statement. */
  rollbacks: number;
  /** Statements run outside any transaction, right after a tenant transaction. */
  outsideChecks: number;
  /** Any check that saw another shop's setting or rows. Must be zero. */
  violations: number;
  samples: string[];
}

export interface SessionHazardResult {
  path: Path;
  /** Statements run outside tenant transactions after one session-level set_config. */
  statements: number;
  /** How many of them could read the victim shop's products. */
  exposed: number;
  /** The same check after the pooled server connections were reset. */
  exposedAfterReset: number;
}

const DIVISION_BY_ZERO = '22012';

function errorCode(error: unknown): string | undefined {
  let current = error as { code?: string; cause?: unknown } | undefined;
  while (current) {
    if (current.code) return current.code;
    current = current.cause as { code?: string; cause?: unknown } | undefined;
  }
  return undefined;
}

/** Small shops keep each check cheap; what matters is how many transactions interleave. */
function smallShops(settings: Settings): string[] {
  const [small] = shopClasses(settings.scale);
  return Array.from({ length: small!.count }, (_, i) => shopUuid(small!.first + i));
}

/**
 * Many callers share few server connections and interleave tenant transactions for random shops.
 * Inside each transaction, the shop setting and every row read must belong to that shop; right
 * after it, a statement outside any transaction must see no shop and no rows. Some transactions
 * roll back, by a thrown error or a failing statement, since those paths end differently.
 */
export async function checkLeaks(
  settings: Settings,
  path: Path,
  clients: number,
): Promise<LeakCheckResult> {
  const db = new Database({
    appUrl: settings.url('rls', path),
    applicationName: 'db-bench:leaks',
    maxConnections: clients,
  });
  const shops = smallShops(settings);
  const result: LeakCheckResult = {
    path,
    clients,
    seconds: settings.durationS,
    transactions: 0,
    rollbacks: 0,
    outsideChecks: 0,
    violations: 0,
    samples: [],
  };
  const violation = (message: string) => {
    result.violations++;
    if (result.samples.length < 5) result.samples.push(message);
  };
  const end = performance.now() + settings.durationS * 1_000;
  try {
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (performance.now() < end) {
          const shop = shops[Math.floor(Math.random() * shops.length)]!;
          const roll = Math.random();
          try {
            await db.tenant(shop, async (tx) => {
              const { rows } = await tx.execute<{ current: string | null; foreign: string }>(sql`
                select platform.current_shop_id() as current,
                       (select count(*) from catalog.products where shop_id <> ${shop}) as foreign`);
              if (rows[0]?.current !== shop)
                violation(`in ${shop}: shop setting ${rows[0]?.current}`);
              if (Number(rows[0]?.foreign) !== 0) violation(`in ${shop}: saw other shops' rows`);
              const sample = await tx.execute<{ shop_id: string }>(
                sql`select shop_id from catalog.products limit 5`,
              );
              if (sample.rows.some((row) => row.shop_id !== shop)) {
                violation(`in ${shop}: unfiltered read returned another shop`);
              }
              if (roll < 0.05) await tx.execute(sql`select 1 / 0`);
              if (roll < 0.1) throw new IntendedRollback();
              // Hold a few transactions open a little, so callers interleave more.
              if (roll < 0.15)
                await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
            });
          } catch (error) {
            if (!(error instanceof IntendedRollback) && errorCode(error) !== DIVISION_BY_ZERO) {
              throw error;
            }
            result.rollbacks++;
          }
          result.transactions++;

          const outside = await db.app.execute<{ shop: string | null; visible: string }>(sql`
            select current_setting('app.shop_id', true) as shop,
                   (select count(*) from catalog.products) as visible`);
          result.outsideChecks++;
          // An ended transaction-local setting reads back as '' rather than NULL.
          if (outside.rows[0]?.shop) violation(`outside: shop setting ${outside.rows[0].shop}`);
          if (Number(outside.rows[0]?.visible) !== 0) violation('outside: products visible');
        }
      }),
    );
    return result;
  } catch (error) {
    throw new Error(`Leak check failed: ${rootMessage(error)}`, { cause: error });
  } finally {
    await db.close();
  }
}

/**
 * The control experiment: one session-level set_config (is_local = false), which the code never
 * does, stays on its server connection and exposes a shop to later statements from other callers.
 * Shows that the leak check would notice a leak. Resets the connections afterwards.
 */
export async function sessionLevelHazard(
  settings: Settings,
  path: Path,
  clients: number,
): Promise<SessionHazardResult> {
  const [small] = shopClasses(settings.scale);
  const victim = shopUuid(small!.first);
  const open = () =>
    new Database({
      appUrl: settings.url('rls', path),
      applicationName: 'db-bench:hazard',
      maxConnections: clients,
    });
  const probe = async (db: Database, statements: number): Promise<number> => {
    let exposed = 0;
    let remaining = statements;
    await Promise.all(
      Array.from({ length: clients }, async () => {
        while (remaining-- > 0) {
          const { rows } = await db.app.execute<{ visible: string }>(
            sql`select count(*) as visible from catalog.products`,
          );
          if (Number(rows[0]?.visible) > 0) exposed++;
        }
      }),
    );
    return exposed;
  };

  const statements = 2_000;
  let db = open();
  let exposed: number;
  try {
    await db.app.execute(sql`select set_config('app.shop_id', ${victim}, false)`);
    exposed = await probe(db, statements);
  } finally {
    await db.close();
  }
  // Direct: closing the pool closed the connection that carried the setting. Pooled: PgBouncer
  // keeps server connections, so ask it to replace them.
  if (path === 'pooled') await reconnectPooler(settings);
  db = open();
  try {
    return { path, statements, exposed, exposedAfterReset: await probe(db, statements) };
  } finally {
    await db.close();
  }
}

/** PgBouncer's RECONNECT: closes every server connection of the database once it is released. */
async function reconnectPooler(settings: Settings): Promise<void> {
  const admin = new URL(settings.adminUrl);
  const pooler = new URL(settings.poolerUrl!);
  const adminConsole = new pg.Client({
    host: pooler.hostname,
    port: Number(pooler.port || 6432),
    database: 'pgbouncer',
    user: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
  });
  await adminConsole.connect();
  try {
    await adminConsole.query(`RECONNECT ${settings.database}`);
    // Wait until PgBouncer has closed the old server connections.
    for (let attempt = 0; attempt < 50; attempt++) {
      const { rows } = await adminConsole.query<{ database: string }>('SHOW SERVERS');
      if (!rows.some((row) => row.database === settings.database)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await adminConsole.end();
  }
}
