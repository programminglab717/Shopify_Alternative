import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import pg from 'pg';
import { loadDataset, shopClasses, type ShopSize } from '../dataset.js';
import {
  checkOperators,
  explainListing,
  leakproofOperators,
  type PlanComparison,
} from '../explain.js';
import { checkLeaks, sessionLevelHazard } from '../leaks.js';
import { runPgbench, type PgbenchResult, type ScriptName } from '../pgbench.js';
import { OPERATIONS, runService, type ServiceResult } from '../service.js';
import { loadSettings, type Path, type Settings } from '../settings.js';
import { ms, percent, perSecond, table } from '../stats.js';

const USAGE = `Usage: pnpm bench:db <command> [--json <file>]

Commands (run seed first):
  seed      Recreate the benchmark database and load the dataset
  explain   Query plans with and without row-level security; which filters can use indexes
  pgbench   Throughput and latency: row-level security on and off, direct and through PgBouncer
  service   The application's ProductService.list, direct and through PgBouncer
  leaks     Shop settings never leak between callers sharing pooled connections
  all       explain, pgbench, service and leaks

Environment: DATABASE_ADMIN_URL (required), BENCH_POOLER_URL (PgBouncer in transaction mode;
pooled runs are skipped without it), BENCH_SCALE=full|smoke, BENCH_DURATION_S, BENCH_WARMUP_S.`;

const out = (text = '') => console.log(text);

async function environment(settings: Settings): Promise<Record<string, string>> {
  const info: Record<string, string> = {
    CPU: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
    Memory: `${Math.round(totalmem() / 2 ** 30)} GiB`,
    Node: process.version,
  };
  const admin = new pg.Client({ connectionString: settings.benchAdminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ server_version: string }>('SHOW server_version');
    info.Postgres = rows[0]!.server_version;
    for (const name of ['shared_buffers', 'max_connections', 'jit']) {
      const setting = await admin.query<Record<string, string>>(`SHOW ${name}`);
      info[`Postgres ${name}`] = Object.values(setting.rows[0]!)[0]!;
    }
  } finally {
    await admin.end();
  }
  try {
    info.pgbench = execFileSync('pgbench', ['--version']).toString().trim();
  } catch {
    info.pgbench = 'not installed';
  }
  if (settings.poolerUrl) {
    const pooler = new URL(settings.poolerUrl);
    const admin = new URL(settings.adminUrl);
    const adminConsole = new pg.Client({
      host: pooler.hostname,
      port: Number(pooler.port || 6432),
      database: 'pgbouncer',
      user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password),
    });
    try {
      await adminConsole.connect();
      const version = await adminConsole.query<{ version: string }>('SHOW VERSION');
      info.PgBouncer = version.rows[0]!.version;
      const config = await adminConsole.query<{ key: string; value: string }>('SHOW CONFIG');
      for (const key of ['pool_mode', 'default_pool_size', 'max_client_conn']) {
        const row = config.rows.find((candidate) => candidate.key === key);
        if (row) info[`PgBouncer ${key}`] = row.value;
      }
    } catch (error) {
      info.PgBouncer = `admin console unavailable (${(error as Error).message})`;
    } finally {
      await adminConsole.end().catch(() => undefined);
    }
  }
  return info;
}

function paths(settings: Settings): Path[] {
  return settings.poolerUrl ? ['direct', 'pooled'] : ['direct'];
}

async function seed(settings: Settings): Promise<unknown> {
  out(`## Dataset (${settings.scale})`);
  const summary = await loadDataset(settings, (message) => out(message));
  out();
  out(
    table(
      ['Shops', 'Count', 'Products', 'Variants', 'Products per shop'],
      summary.shops.map((row) => {
        const spec = shopClasses(settings.scale).find((c) => c.size === row.size)!;
        return [
          row.size,
          row.shops,
          row.products.toLocaleString('en'),
          row.variants.toLocaleString('en'),
          `${spec.products[0].toLocaleString('en')}–${spec.products[1].toLocaleString('en')}`,
        ];
      }),
    ),
  );
  out();
  out(
    table(
      ['Table', 'Size with indexes'],
      summary.tables.map((row) => [row.table, row.size]),
    ),
  );
  out();
  out(
    `Search words: "lawn" in ${percent(summary.searchSelectivity.common)} of products, ` +
      `"organza" in ${percent(summary.searchSelectivity.rare)}. Loaded in ${summary.seconds.toFixed(0)} s.`,
  );
  return summary;
}

function planTable(comparisons: PlanComparison[]): string {
  return table(
    [
      'Query',
      'Plan with RLS',
      'Same plan without RLS?',
      'Execution ms without / with',
      'Planning ms without / with',
    ],
    comparisons.map((c) => [
      c.description,
      c.rls.scans.join(' → '),
      c.rls.scans.join() === c.bypass.scans.join() ? 'yes' : `no: ${c.bypass.scans.join(' → ')}`,
      `${ms(c.bypass.ms)}${jitNote(c.bypass)} / ${ms(c.rls.ms)}${jitNote(c.rls)}`,
      `${ms(c.bypass.planningMs)} / ${ms(c.rls.planningMs)}`,
    ]),
  );
}

function jitNote(plan: PlanComparison['rls']): string {
  return plan.jitMs === undefined ? '' : ` (JIT ${ms(plan.jitMs)})`;
}

async function explain(settings: Settings): Promise<unknown> {
  out('## Query plans (largest shop)');
  out();
  const listing = await explainListing(settings);
  out(planTable(listing));
  out();
  for (const comparison of listing) {
    out(`<details><summary>${comparison.description}: plan with RLS</summary>`);
    out();
    out('```');
    out(comparison.rls.text);
    out('```');
    out();
    out('</details>');
  }
  out();
  out('## Which filters can use an index under RLS');
  out();
  const operators = await checkOperators(settings);
  out(
    table(
      [
        'Filter',
        'Operator function',
        'Leakproof',
        'Plan without RLS',
        'Plan with RLS',
        'ms without',
        'ms with',
      ],
      operators.map((check) => [
        `\`${check.condition}\``,
        check.function,
        check.leakproof ? 'yes' : 'no',
        check.comparison.bypass.scans.join(' → '),
        check.comparison.rls.scans.join(' → '),
        ms(check.comparison.bypass.ms),
        ms(check.comparison.rls.ms),
      ]),
    ),
  );
  out();
  const flags = await leakproofOperators(settings);
  out(
    `Leakproof: ${flags
      .filter((f) => f.leakproof)
      .map((f) => f.name)
      .join(', ')}. ` +
      `Not leakproof: ${flags
        .filter((f) => !f.leakproof)
        .map((f) => f.name)
        .join(', ')}.`,
  );
  return { listing, operators, flags };
}

async function pgbench(settings: Settings): Promise<unknown> {
  const results: PgbenchResult[] = [];
  const run = async (run: Parameters<typeof runPgbench>[1]) => {
    const result = await runPgbench(settings, run);
    results.push(result);
    process.stderr.write(
      `  ${run.script} ${run.shops} ${run.login} ${run.path} c=${run.clients}: ` +
        (result.ok
          ? `${perSecond(result.tps!)} tps, p95 ${ms(result.latency!.p95)} ms\n`
          : `${result.error}\n`),
    );
    return result;
  };

  // Timings drift upwards for minutes on a freshly started machine; warm up both logins first.
  for (const login of ['bypass', 'rls'] as const) {
    await runPgbench(settings, {
      script: 'list',
      shops: 'medium',
      login,
      path: 'direct',
      clients: 8,
      seconds: settings.warmupS * 5,
    });
  }

  const rounds = settings.scale === 'smoke' ? 1 : 3;
  const seconds = Math.max(1, Math.round((settings.durationS * 2) / 3));
  out(
    `## Row-level security overhead (pgbench, direct, 8 clients, median of ${rounds} ` +
      `alternating rounds of ${seconds} s)`,
  );
  out();
  const workloads: [ScriptName, ShopSize][] = [
    ['list', 'small'],
    ['list', 'medium'],
    ['list', 'large'],
    ['search-common', 'large'],
    ['search-rare', 'large'],
    ['lookup', 'medium'],
  ];
  const rows: (string | number)[][] = [];
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? NaN;
  };
  for (const [script, shops] of workloads) {
    const samples: Record<'bypass' | 'rls', PgbenchResult[]> = { bypass: [], rls: [] };
    for (let round = 0; round < rounds; round++) {
      // Alternate which goes first, so drift over time affects both equally.
      const order = round % 2 === 0 ? (['bypass', 'rls'] as const) : (['rls', 'bypass'] as const);
      for (const login of order) {
        samples[login].push(
          await run({ script, shops, login, path: 'direct', clients: 8, seconds }),
        );
      }
    }
    const ok = [...samples.bypass, ...samples.rls].every((result) => result.ok);
    const tps = (login: 'bypass' | 'rls') => samples[login].map((result) => result.tps!);
    const p95 = (login: 'bypass' | 'rls') => median(samples[login].map((r) => r.latency!.p95));
    const range = (values: number[]) =>
      `${perSecond(Math.min(...values))}–${perSecond(Math.max(...values))}`;
    rows.push(
      ok
        ? [
            script,
            shops,
            `${perSecond(median(tps('bypass')))} (${range(tps('bypass'))})`,
            `${perSecond(median(tps('rls')))} (${range(tps('rls'))})`,
            percent(median(tps('rls')) / median(tps('bypass')) - 1),
            ms(p95('bypass')),
            ms(p95('rls')),
          ]
        : [script, shops, 'failed', '', '', '', ''],
    );
  }
  out(
    table(
      [
        'Workload',
        'Shops',
        'tps without RLS',
        'tps with RLS',
        'Change',
        'p95 ms without',
        'p95 ms with',
      ],
      rows,
    ),
  );
  out();

  out('## Direct connections and PgBouncer (pgbench, RLS on, products page, medium shops)');
  out();
  // Direct connections stop at 128: Postgres allows 100 by default.
  const clientCounts = [1, 8, 32, 64, 128, 512, 1024];
  const byClients = new Map<number, Partial<Record<Path, PgbenchResult>>>();
  for (const [index, clients] of clientCounts.entries()) {
    const available = paths(settings).filter((path) => path === 'pooled' || clients <= 128);
    // Alternate which goes first, so drift over time affects both equally.
    for (const path of index % 2 === 0 ? available : [...available].reverse()) {
      const result = await run({ script: 'list', shops: 'medium', login: 'rls', path, clients });
      byClients.set(clients, { ...byClients.get(clients), [path]: result });
    }
  }
  const cell = (result: PgbenchResult | undefined, field: 'tps' | 'p50' | 'p95' | 'p99') => {
    if (!result) return '–';
    if (!result.ok) return field === 'tps' ? `fails: ${result.error}` : '';
    return field === 'tps' ? perSecond(result.tps!) : ms(result.latency![field]);
  };
  out(
    table(
      [
        'Clients',
        'Direct tps',
        'Direct p50 / p95 / p99 ms',
        'PgBouncer tps',
        'PgBouncer p50 / p95 / p99 ms',
      ],
      [...byClients.entries()]
        .sort(([a], [b]) => a - b)
        .map(([clients, byPath]) => [
          clients,
          cell(byPath.direct, 'tps'),
          byPath.direct?.ok
            ? `${cell(byPath.direct, 'p50')} / ${cell(byPath.direct, 'p95')} / ${cell(byPath.direct, 'p99')}`
            : '',
          cell(byPath.pooled, 'tps'),
          byPath.pooled?.ok
            ? `${cell(byPath.pooled, 'p50')} / ${cell(byPath.pooled, 'p95')} / ${cell(byPath.pooled, 'p99')}`
            : '',
        ]),
    ),
  );
  out();

  out('## Round trips (pgbench, 1 client, mean latency)');
  out();
  const tripRows: (string | number)[][] = [];
  for (const script of ['select-1', 'tenant-tx'] as const) {
    const row: (string | number)[] = [
      script === 'select-1'
        ? 'select 1 (1 round trip)'
        : 'Tenant transaction around select 1 (3 round trips)',
    ];
    for (const path of paths(settings)) {
      const result = await run({ script, shops: 'small', login: 'rls', path, clients: 1 });
      row.push(result.ok ? ms(result.latency!.mean) : 'failed');
    }
    tripRows.push(row);
  }
  out(table(['Statement', 'Direct ms', ...(settings.poolerUrl ? ['PgBouncer ms'] : [])], tripRows));
  return results;
}

async function service(settings: Settings): Promise<unknown> {
  out('## The application code (ProductService, RLS on, medium shops)');
  out();
  const results: ServiceResult[] = [];
  const runs = [
    { operation: 'list', concurrency: 1 },
    { operation: 'list', concurrency: 16 },
    { operation: 'tenant-select-1', concurrency: 1 },
    { operation: 'select-1', concurrency: 1 },
  ] as const;
  const rows: (string | number)[][] = [];
  for (const [index, { operation, concurrency }] of runs.entries()) {
    const order = index % 2 === 0 ? paths(settings) : [...paths(settings)].reverse();
    for (const path of order) {
      const result = await runService(settings, { operation, concurrency, path, shops: 'medium' });
      results.push(result);
      process.stderr.write(
        `  ${operation} ${path} c=${concurrency}: ${result.ok ? 'ok' : result.error}\n`,
      );
      rows.push([
        OPERATIONS[operation],
        concurrency,
        path === 'direct' ? 'direct' : 'PgBouncer',
        result.ok ? perSecond(result.latency!.throughput) : `fails: ${result.error}`,
        result.ok ? ms(result.latency!.p50) : '',
        result.ok ? ms(result.latency!.p95) : '',
        result.ok ? ms(result.latency!.p99) : '',
      ]);
    }
  }
  out(table(['Operation', 'Callers', 'Connection', 'Calls/s', 'p50 ms', 'p95 ms', 'p99 ms'], rows));
  return results;
}

async function leaks(settings: Settings): Promise<unknown> {
  out('## Shop settings under pooling');
  out();
  const checks = [];
  for (const path of paths(settings)) {
    const result = await checkLeaks(settings, path, path === 'direct' ? 32 : 128);
    checks.push(result);
    process.stderr.write(
      `  leak check ${path}: ${result.transactions} transactions, ${result.violations} violations\n`,
    );
  }
  out(
    table(
      [
        'Connection',
        'Callers',
        'Tenant transactions',
        'Rolled back',
        'Checks outside transactions',
        'Leaks',
      ],
      checks.map((c) => [
        c.path === 'direct' ? 'direct' : 'PgBouncer',
        c.clients,
        c.transactions.toLocaleString('en'),
        c.rollbacks.toLocaleString('en'),
        c.outsideChecks.toLocaleString('en'),
        c.violations === 0 ? '0' : `${c.violations}: ${c.samples.join('; ')}`,
      ]),
    ),
  );
  out();
  const hazards = [];
  for (const path of paths(settings)) {
    hazards.push(await sessionLevelHazard(settings, path, path === 'direct' ? 8 : 32));
  }
  out(
    'Control: one session-level `set_config(…, false)`, which the code never does, then statements',
  );
  out('outside tenant transactions from other callers:');
  out();
  out(
    table(
      ['Connection', 'Statements', 'Could read the shop', 'After resetting connections'],
      hazards.map((h) => [
        h.path === 'direct' ? 'direct' : 'PgBouncer',
        h.statements.toLocaleString('en'),
        h.exposed.toLocaleString('en'),
        h.exposedAfterReset.toLocaleString('en'),
      ]),
    ),
  );
  return { checks, hazards };
}

const args = process.argv.slice(2);
const command = args[0];
const jsonIndex = args.indexOf('--json');
const jsonFile = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
const commands: Record<string, (settings: Settings) => Promise<unknown>> = {
  seed,
  explain,
  pgbench,
  service,
  leaks,
  async all(settings) {
    const results: Record<string, unknown> = {};
    for (const name of ['explain', 'pgbench', 'service', 'leaks']) {
      results[name] = await commands[name]!(settings);
      out();
    }
    return results;
  },
};

if (!command || !commands[command]) {
  out(USAGE);
  process.exit(command ? 1 : 0);
}

const settings = loadSettings();
const env = await environment(settings).catch(() => ({}));
out(`# Spike 5 benchmark · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
out();
out(
  table(
    ['Setting', 'Value'],
    [
      ['Scale', settings.scale],
      ['Measured seconds per run (warm-up)', `${settings.durationS} (${settings.warmupS})`],
      ...Object.entries(env),
    ],
  ),
);
out();
const results = await commands[command]!(settings);
if (jsonFile) {
  const { scale, durationS, warmupS, database, poolerUrl } = settings;
  await writeFile(
    jsonFile,
    JSON.stringify(
      {
        command,
        settings: { scale, durationS, warmupS, database, pooled: Boolean(poolerUrl) },
        environment: env,
        results,
      },
      null,
      2,
    ),
  );
}
