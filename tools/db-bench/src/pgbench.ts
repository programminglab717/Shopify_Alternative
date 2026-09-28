import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEARCH_WORDS, shopClass, type ShopSize } from './dataset.js';
import { LOGINS, type LoginName, type Path, type Settings } from './settings.js';
import { summarize, type LatencySummary } from './stats.js';

/*
 * pgbench scripts that send what ProductService sends (captured from the driver), one statement
 * per round trip. Two differences, both the same for every scenario: values are inlined, because
 * pgbench substitutes variables as text in simple-protocol mode, and the variants query selects
 * the page's products with a subquery where the service passes their 50 ids.
 */

const SHOP = `'00000000-0000-7000-8000-000000:n'`;
const PRODUCT_COLUMNS = `"shop_id", "id", "title", "handle", "status", "description", "vendor", "product_type", "tags", "search_text", "version", "created_at", "updated_at"`;
const VARIANT_COLUMNS = `"shop_id", "id", "product_id", "title", "sku", "barcode", "price", "compare_at_price", "position", "created_at", "updated_at"`;

function listing(filter: string): string {
  return `\\set n random(:first, :last)
BEGIN;
SELECT set_config('app.shop_id', ${SHOP}, true);
SELECT ${PRODUCT_COLUMNS} FROM "catalog"."products" WHERE ("catalog"."products"."shop_id" = ${SHOP}${filter}) ORDER BY "catalog"."products"."id" DESC LIMIT 51;
SELECT ${VARIANT_COLUMNS} FROM "catalog"."variants" WHERE ("catalog"."variants"."shop_id" = ${SHOP} AND "catalog"."variants"."product_id" IN (SELECT "id" FROM "catalog"."products" WHERE ("catalog"."products"."shop_id" = ${SHOP}${filter}) ORDER BY "id" DESC LIMIT 50)) ORDER BY "catalog"."variants"."product_id" ASC, "catalog"."variants"."position" ASC;
END;
`;
}

const byHandle = `"catalog"."products"."shop_id" = ${SHOP} AND "catalog"."products"."handle" = 'item-:k'`;

export const SCRIPTS = {
  /** The admin products page: newest 50 products with their variants. */
  list: listing(''),
  /** The same page filtered by a word in about one title in seven. */
  'search-common': listing(
    ` AND "catalog"."products"."search_text" LIKE '%${SEARCH_WORDS.common}%'`,
  ),
  /** Filtered by a word in about 1% of titles: scans most of the shop's products. */
  'search-rare': listing(` AND "catalog"."products"."search_text" LIKE '%${SEARCH_WORDS.rare}%'`),
  /** One product and its variants by handle, as the storefront will look products up. */
  lookup: `\\set n random(:first, :last)
\\set k random(1, :minproducts)
BEGIN;
SELECT set_config('app.shop_id', ${SHOP}, true);
SELECT ${PRODUCT_COLUMNS} FROM "catalog"."products" WHERE (${byHandle});
SELECT ${VARIANT_COLUMNS} FROM "catalog"."variants" WHERE ("catalog"."variants"."shop_id" = ${SHOP} AND "catalog"."variants"."product_id" IN (SELECT "id" FROM "catalog"."products" WHERE (${byHandle}))) ORDER BY "catalog"."variants"."product_id" ASC, "catalog"."variants"."position" ASC;
END;
`,
  /** A tenant transaction around a trivial statement: the cost of the wrapper itself. */
  'tenant-tx': `\\set n random(:first, :last)
BEGIN;
SELECT set_config('app.shop_id', ${SHOP}, true);
SELECT 1;
END;
`,
  /** One round trip. */
  'select-1': `SELECT 1;
`,
} as const;

export type ScriptName = keyof typeof SCRIPTS;

export interface PgbenchRun {
  script: ScriptName;
  shops: ShopSize;
  login: LoginName;
  path: Path;
  clients: number;
  /** Measured seconds, if not the configured duration. */
  seconds?: number;
}

export interface PgbenchResult extends PgbenchRun {
  ok: boolean;
  error?: string;
  /** Transactions per second, as pgbench reports it (excluding connection set-up). */
  tps?: number;
  failed?: number;
  latency?: LatencySummary;
}

function runProcess(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // pgbench keeps one socket per client; lift the open-file limit for the 1,000-client runs.
    const child = spawn('sh', ['-c', `ulimit -n 8192 2>/dev/null; exec ${command}`], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Per-transaction latencies from pgbench's -l logs: the third field is microseconds. */
async function readLatencies(dir: string): Promise<number[]> {
  const latencies: number[] = [];
  for (const file of await readdir(dir)) {
    if (!file.startsWith('tx.')) continue;
    for (const line of (await readFile(join(dir, file), 'utf8')).split('\n')) {
      const micros = Number(line.split(' ')[2]);
      if (Number.isFinite(micros) && line.length > 0) latencies.push(micros / 1_000);
    }
  }
  return latencies;
}

/** Runs one scenario: a warm-up, then a measured run with per-transaction logging. */
export async function runPgbench(settings: Settings, run: PgbenchRun): Promise<PgbenchResult> {
  const dir = await mkdtemp(join(tmpdir(), 'hatti-pgbench-'));
  try {
    const scriptFile = join(dir, 'script.sql');
    await writeFile(scriptFile, SCRIPTS[run.script]);
    const shops = shopClass(settings.scale, run.shops);
    const url = new URL(settings.url(run.login, run.path));
    const { user, password } = LOGINS[run.login];
    const env = {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGDATABASE: settings.database,
      PGUSER: user,
      PGPASSWORD: password,
      PGAPPNAME: 'hatti-pgbench',
      // Encryption costs the same on every path; leave it out so the runs compare pooling itself.
      PGSSLMODE: 'disable',
    };
    const threads = Math.min(run.clients, 4);
    const base = [
      'pgbench',
      '--no-vacuum',
      '--protocol=simple',
      `--client=${run.clients}`,
      `--jobs=${threads}`,
      `--define=first=${shops.first}`,
      `--define=last=${shops.last}`,
      `--define=minproducts=${shops.products[0]}`,
      `--file=${scriptFile}`,
    ];
    if (settings.warmupS > 0) {
      const warmup = await runProcess([...base, `--time=${settings.warmupS}`].join(' '), env);
      if (warmup.code !== 0) return { ...run, ok: false, error: lastLine(warmup.stderr) };
    }
    const seconds = run.seconds ?? settings.durationS;
    const measured = await runProcess(
      [...base, `--time=${seconds}`, '--log', `--log-prefix=${join(dir, 'tx')}`].join(' '),
      env,
    );
    if (measured.code !== 0) return { ...run, ok: false, error: lastLine(measured.stderr) };
    const tps = Number(/^tps = ([\d.]+)/m.exec(measured.stdout)?.[1]);
    const failed = Number(/^number of failed transactions: (\d+)/m.exec(measured.stdout)?.[1] ?? 0);
    return {
      ...run,
      ok: true,
      tps,
      failed,
      latency: summarize(await readLatencies(dir), seconds),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return (lines.find((line) => /error|fatal|sorry/i.test(line)) ?? lines.at(-1) ?? '').trim();
}
