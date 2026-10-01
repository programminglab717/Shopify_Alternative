import { Database } from '@hatti/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { shopClass, shopUuid, type ShopSize } from './dataset.js';
import {
  OPERATIONS,
  SHOP_OPERATIONS,
  runOnce,
  samplesOf,
  servicesOf,
  type ShopSamples,
} from './service.js';
import type { Settings } from './settings.js';

/**
 * Checks the statements the application prepares by name (ADR-108): for each, the generic plan
 * Postgres may keep for every shop after five runs, against the plan it makes for the values of a
 * small, a medium and a large shop. The statements are the application's own, as the driver is
 * asked to run them, so the check cannot drift from the code.
 */

interface Captured {
  name: string;
  text: string;
  values: unknown[];
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/** Scan nodes, with their index or table: what a plan reads, and how. */
function scansOf(node: PlanNode): string[] {
  const own =
    node['Relation Name'] || node['Index Name']
      ? [`${node['Node Type']} on ${node['Index Name'] ?? node['Relation Name']}`]
      : [];
  return [...own, ...(node.Plans ?? []).flatMap(scansOf)];
}

type Query = (config: unknown, values?: unknown, callback?: unknown) => unknown;

/** The statements the driver is asked to run by name while `fn` runs, with their values. */
async function capture(fn: () => Promise<unknown>): Promise<Captured[]> {
  const captured: Captured[] = [];
  const prototype = pg.Client.prototype as unknown as { query: Query };
  const query = prototype.query;
  prototype.query = function (this: unknown, config, values, callback) {
    const named = config as { name?: string; text?: string; values?: unknown[] } | null;
    if (named && typeof named === 'object' && named.name && named.text) {
      captured.push({
        name: named.name,
        text: named.text,
        values: Array.isArray(values) ? values : (named.values ?? []),
      });
    }
    return query.call(this, config, values, callback);
  };
  try {
    await fn();
  } finally {
    prototype.query = query;
  }
  return captured;
}

/** The table a plan reads first, which drives the rest: "orders". */
function tableOf(node: PlanNode): string | undefined {
  return node['Relation Name'] ?? (node.Plans ?? []).map(tableOf).find(Boolean);
}

export interface PreparedCheck {
  operation: string;
  statement: string;
  table: string;
  size: ShopSize;
  genericPlan: string[];
  customPlan: string[];
  /** Median of three EXPLAIN ANALYZE runs for the shop's values, in ms. */
  planningMs: number;
  executionMs: number;
  /** How Postgres ran it in ten calls on one connection: generic and custom plans. */
  genericRuns: number;
  customRuns: number;
  text: string;
}

async function plansOf(
  settings: Settings,
  shopId: string,
  statement: Captured,
): Promise<{
  table: string;
  generic: string[];
  custom: string[];
  planningMs: number;
  executionMs: number;
}> {
  const client = new pg.Client({ connectionString: settings.url('rls', 'direct') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const generic = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${statement.text}`,
    );
    const runs: { Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }[] = [];
    for (let run = 0; run < 4; run++) {
      const { rows } = await client.query<{
        'QUERY PLAN': [{ Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }];
      }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, statement.values);
      // The first run warms the session's caches.
      if (run > 0) runs.push(rows[0]!['QUERY PLAN'][0]);
    }
    await client.query('ROLLBACK');
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
    const genericPlan = generic.rows[0]!['QUERY PLAN'][0].Plan;
    return {
      table: tableOf(genericPlan) ?? 'none',
      generic: scansOf(genericPlan),
      custom: scansOf(runs[0]!.Plan),
      planningMs: median(runs.map((run) => run['Planning Time'])),
      executionMs: median(runs.map((run) => run['Execution Time'])),
    };
  } finally {
    await client.end();
  }
}

/**
 * For each operation and shop size: the statements one call prepares, their plans, and how
 * Postgres chose to run them over ten calls on one connection.
 */
export async function checkPrepared(settings: Settings): Promise<PreparedCheck[]> {
  const checks: PreparedCheck[] = [];
  for (const size of ['small', 'medium', 'large'] as const) {
    const samples: ShopSamples = await samplesOf(settings, shopClass(settings.scale, size));
    // The class's first shop with orders and carts, so every operation reads the same shop.
    const shop =
      [...samples.carts.keys()].find((n) => samples.orders.has(n)) ?? samples.shops.first;
    const shopId = shopUuid(shop);
    for (const operation of SHOP_OPERATIONS) {
      const db = new Database({
        appUrl: settings.url('rls', 'direct'),
        applicationName: 'db-bench-prepared',
        maxConnections: 1,
      });
      try {
        const services = servicesOf(db);
        const statements = await capture(() => runOnce(db, services, samples, operation, shop));
        for (let call = 1; call < 10; call++) await runOnce(db, services, samples, operation, shop);
        const { rows: uses } = await db.tenant(shopId, (tx) =>
          tx.execute<{ name: string; generic_plans: string; custom_plans: string }>(
            sql`SELECT name, generic_plans, custom_plans FROM pg_prepared_statements`,
          ),
        );
        const seen = new Set<string>();
        for (const statement of statements) {
          if (seen.has(statement.name)) continue;
          seen.add(statement.name);
          const plans = await plansOf(settings, shopId, statement);
          const use = uses.find((row) => row.name === statement.name);
          checks.push({
            operation: OPERATIONS[operation],
            statement: statement.name,
            table: plans.table,
            size,
            genericPlan: plans.generic,
            customPlan: plans.custom,
            planningMs: plans.planningMs,
            executionMs: plans.executionMs,
            genericRuns: Number(use?.generic_plans ?? 0),
            customRuns: Number(use?.custom_plans ?? 0),
            text: statement.text,
          });
        }
      } finally {
        await db.close();
      }
    }
  }
  return checks;
}
