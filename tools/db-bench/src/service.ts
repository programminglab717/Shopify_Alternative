import type { TenantContext } from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { Database } from '@hatti/db';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { shopClass, shopUuid, type ShopSize } from './dataset.js';
import type { Path, Settings } from './settings.js';
import { summarize, type LatencySummary } from './stats.js';

export const OPERATIONS = {
  /** ProductService.list, first page of 50: what the admin products page runs. */
  list: 'ProductService.list (50 products)',
  /** db.tenant() around `select 1`: begin, set_config, select, commit. */
  'tenant-select-1': 'Tenant transaction around select 1',
  /** A single statement outside any transaction. */
  'select-1': 'select 1',
} as const;

export type Operation = keyof typeof OPERATIONS;

export interface ServiceRun {
  operation: Operation;
  path: Path;
  concurrency: number;
  shops: ShopSize;
}

export interface ServiceResult extends ServiceRun {
  ok: boolean;
  error?: string;
  latency?: LatencySummary;
}

function tenantFor(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    scopes: new Set(['read_products']),
    actor: { kind: 'app', tokenId: newId() },
  };
}

/**
 * Runs the application's own code (Drizzle, node-postgres, row mapping) as hatti_app, so row-level
 * security applies. `concurrency` callers loop for the duration; each waits for its previous call.
 */
export async function runService(settings: Settings, run: ServiceRun): Promise<ServiceResult> {
  const db = new Database({
    appUrl: settings.url('rls', run.path),
    applicationName: 'db-bench',
    maxConnections: run.concurrency,
  });
  const service = new ProductService(db);
  const shops = shopClass(settings.scale, run.shops);
  const randomShop = () => shopUuid(shops.first + Math.floor(Math.random() * shops.count));
  const operations: Record<Operation, () => Promise<unknown>> = {
    list: () => service.list(tenantFor(randomShop()), { first: 50 }),
    'tenant-select-1': () => db.tenant(randomShop(), (tx) => tx.execute(sql`select 1`)),
    'select-1': () => db.app.execute(sql`select 1`),
  };
  const operation = operations[run.operation];

  const loop = async (seconds: number): Promise<number[]> => {
    const latencies: number[] = [];
    const end = performance.now() + seconds * 1_000;
    await Promise.all(
      Array.from({ length: run.concurrency }, async () => {
        while (performance.now() < end) {
          const start = performance.now();
          await operation();
          latencies.push(performance.now() - start);
        }
      }),
    );
    return latencies;
  };

  try {
    if (settings.warmupS > 0) await loop(settings.warmupS);
    const latencies = await loop(settings.durationS);
    return { ...run, ok: true, latency: summarize(latencies, settings.durationS) };
  } catch (error) {
    return { ...run, ok: false, error: rootMessage(error) };
  } finally {
    await db.close();
  }
}

/** Drizzle wraps driver errors; the driver's message is the useful one. */
export function rootMessage(error: unknown): string {
  let current = error as { message?: string; cause?: unknown };
  while (current.cause) current = current.cause as { message?: string; cause?: unknown };
  return current.message ?? String(error);
}
