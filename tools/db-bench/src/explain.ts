import pg from 'pg';
import { RARE_TAG, SEARCH_WORDS, shopClass, shopUuid } from './dataset.js';
import type { LoginName, Settings } from './settings.js';

export interface PlanSummary {
  /** Scan nodes with their index, e.g. "Index Scan Backward on products_pkey". */
  scans: string[];
  /** Median execution time of five EXPLAIN ANALYZE runs, in ms. */
  ms: number;
  /** Median planning time of the same runs, in ms; the first run warms the session's caches. */
  planningMs: number;
  /** Time spent compiling the query with JIT, when Postgres chose to. */
  jitMs?: number;
  /** The plan as text, for the report. */
  text: string;
}

export interface PlanComparison {
  name: string;
  description: string;
  rls: PlanSummary;
  bypass: PlanSummary;
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

interface ExplainResult {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
  JIT?: { Timing: { Total: number } };
}

function scansOf(node: PlanNode): string[] {
  const own =
    node['Relation Name'] || node['Index Name']
      ? [`${node['Node Type']} on ${node['Index Name'] ?? node['Relation Name']}`]
      : [];
  return [...own, ...(node.Plans ?? []).flatMap(scansOf)];
}

/** Runs EXPLAIN ANALYZE as `login` inside a tenant transaction for `shopId`. */
async function explain(
  settings: Settings,
  login: LoginName,
  shopId: string,
  query: string,
): Promise<PlanSummary> {
  const client = new pg.Client({ connectionString: settings.url(login, 'direct') });
  await client.connect();
  try {
    const times: number[] = [];
    const planning: number[] = [];
    let scans: string[] = [];
    let text = '';
    let jitMs: number | undefined;
    for (let run = 0; run < 5; run++) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
      const { rows } = await client.query<{ 'QUERY PLAN': [ExplainResult] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      );
      const [result] = rows[0]!['QUERY PLAN'];
      times.push(result['Execution Time']);
      if (run > 0) planning.push(result['Planning Time']);
      if (result.JIT) jitMs = result.JIT.Timing.Total;
      scans = scansOf(result.Plan);
      if (run === 0) {
        const textPlan = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${query}`,
        );
        text = textPlan.rows.map((row) => row['QUERY PLAN']).join('\n');
      }
      await client.query('ROLLBACK');
    }
    times.sort((a, b) => a - b);
    planning.sort((a, b) => a - b);
    return {
      scans,
      ms: times[2]!,
      planningMs: (planning[1]! + planning[2]!) / 2,
      text,
      ...(jitMs === undefined ? {} : { jitMs }),
    };
  } finally {
    await client.end();
  }
}

async function compare(
  settings: Settings,
  shopId: string,
  name: string,
  description: string,
  query: string,
): Promise<PlanComparison> {
  return {
    name,
    description,
    rls: await explain(settings, 'rls', shopId, query),
    bypass: await explain(settings, 'bypass', shopId, query),
  };
}

const PRODUCT_COLUMNS = `"shop_id", "id", "title", "handle", "status", "description", "vendor", "product_type", "tags", "search_text", "version", "created_at", "updated_at"`;

/** The listing's queries on the largest shop, with and without row-level security. */
export async function explainListing(settings: Settings): Promise<PlanComparison[]> {
  const large = shopClass(settings.scale, 'large');
  const shopId = shopUuid(large.first);
  const admin = new pg.Client({ connectionString: settings.benchAdminUrl });
  await admin.connect();
  let deepCursor: string;
  let pageIds: string[];
  try {
    const deep = await admin.query<{ id: string }>(
      `SELECT id FROM catalog.products WHERE shop_id = $1 ORDER BY id DESC
        OFFSET least(5000, (SELECT count(*) / 2 FROM catalog.products WHERE shop_id = $1)) LIMIT 1`,
      [shopId],
    );
    deepCursor = deep.rows[0]!.id;
    const page = await admin.query<{ id: string }>(
      'SELECT id FROM catalog.products WHERE shop_id = $1 ORDER BY id DESC LIMIT 50',
      [shopId],
    );
    pageIds = page.rows.map((row) => row.id);
  } finally {
    await admin.end();
  }
  const shop = pg.escapeLiteral(shopId);
  const products = (filter: string) =>
    `SELECT ${PRODUCT_COLUMNS} FROM catalog.products WHERE shop_id = ${shop}${filter} ORDER BY id DESC LIMIT 51`;
  return [
    await compare(settings, shopId, 'list', 'First page, newest first', products('')),
    await compare(
      settings,
      shopId,
      'list-deep',
      'A page deep in the list (cursor: id < …, up to 5,000 products in)',
      products(` AND id < ${pg.escapeLiteral(deepCursor)}`),
    ),
    await compare(
      settings,
      shopId,
      'search-common',
      `First page matching "${SEARCH_WORDS.common}"`,
      products(` AND search_text LIKE '%${SEARCH_WORDS.common}%'`),
    ),
    await compare(
      settings,
      shopId,
      'search-rare',
      `First page matching "${SEARCH_WORDS.rare}"`,
      products(` AND search_text LIKE '%${SEARCH_WORDS.rare}%'`),
    ),
    await compare(
      settings,
      shopId,
      'lookup',
      'One product by handle',
      `SELECT ${PRODUCT_COLUMNS} FROM catalog.products WHERE shop_id = ${shop} AND handle = 'item-42'`,
    ),
    await compare(
      settings,
      shopId,
      'variants',
      "The page's variants (50 product ids)",
      `SELECT * FROM catalog.variants WHERE shop_id = ${shop} AND product_id IN (${pageIds
        .map((id) => pg.escapeLiteral(id))
        .join(', ')}) ORDER BY product_id, position`,
    ),
  ];
}

export interface OperatorCheck {
  condition: string;
  function: string;
  leakproof: boolean;
  comparison: PlanComparison;
}

/**
 * Which filters can use an index under row-level security. Postgres checks the policy first and
 * lets a filter run before it, or inside an index scan, only if its operator is leakproof. Adds
 * trigram, GIN and B-tree indexes to the benchmark database for the check, then drops them.
 */
export async function checkOperators(settings: Settings): Promise<OperatorCheck[]> {
  const large = shopClass(settings.scale, 'large');
  const shopId = shopUuid(large.first);
  const shop = pg.escapeLiteral(shopId);
  const admin = new pg.Client({ connectionString: settings.benchAdminUrl });
  await admin.connect();
  const cases = [
    {
      condition: `search_text LIKE '%${SEARCH_WORDS.rare}%'`,
      function: 'textlike',
      index:
        'CREATE INDEX bench_products_search_trgm ON catalog.products USING gin (search_text gin_trgm_ops)',
    },
    {
      condition: `tags @> ARRAY['${RARE_TAG}']`,
      function: 'arraycontains',
      index: 'CREATE INDEX bench_products_tags ON catalog.products USING gin (tags)',
    },
    {
      condition: `status = 'archived'`,
      function: 'texteq',
      index: 'CREATE INDEX bench_products_status ON catalog.products (shop_id, status)',
    },
  ];
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    for (const { index } of cases) await admin.query(index);
    await admin.query('ANALYZE catalog.products');
    const checks: OperatorCheck[] = [];
    for (const item of cases) {
      const { rows } = await admin.query<{ proleakproof: boolean }>(
        'SELECT proleakproof FROM pg_proc WHERE proname = $1',
        [item.function],
      );
      checks.push({
        condition: item.condition,
        function: item.function,
        leakproof: rows[0]?.proleakproof ?? false,
        comparison: await compare(
          settings,
          shopId,
          item.function,
          item.condition,
          `SELECT count(*) FROM catalog.products WHERE shop_id = ${shop} AND ${item.condition}`,
        ),
      });
    }
    return checks;
  } finally {
    for (const name of [
      'bench_products_search_trgm',
      'bench_products_tags',
      'bench_products_status',
    ]) {
      await admin.query(`DROP INDEX IF EXISTS catalog.${name}`);
    }
    await admin.end();
  }
}

/** Leakproof flags of the operators the catalog filters with, straight from pg_proc. */
export async function leakproofOperators(
  settings: Settings,
): Promise<{ name: string; leakproof: boolean }[]> {
  const admin = new pg.Client({ connectionString: settings.benchAdminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ name: string; leakproof: boolean }>(
      `SELECT DISTINCT proname AS name, proleakproof AS leakproof
         FROM pg_proc
        WHERE proname = ANY($1)
        ORDER BY 1`,
      [
        [
          'uuid_eq',
          'uuid_lt',
          'texteq',
          'text_lt',
          'int4eq',
          'int8lt',
          'timestamptz_lt',
          'textlike',
          'texticlike',
          'textregexeq',
          'arraycontains',
          'arrayoverlap',
          'jsonb_contains',
          'ts_match_vq',
        ],
      ],
    );
    return rows;
  } finally {
    await admin.end();
  }
}
