import { env, parseEnv, z } from '@hatti/config';
import { withCredentials, withDatabase } from '@hatti/db';
import { TEST_LOGINS } from '@hatti/db/testing';

const schema = z.object({
  /** Superuser, direct to Postgres: creates the benchmark database and loads it. */
  DATABASE_ADMIN_URL: env.postgresUrl(),
  BENCH_DATABASE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default('hatti_bench'),
  /** PgBouncer in transaction mode, e.g. postgres://127.0.0.1:6432. Pooled runs are skipped without it. */
  BENCH_POOLER_URL: env.postgresUrl().optional(),
  /** "smoke" loads a tiny dataset and runs briefly, to check the tool itself. */
  BENCH_SCALE: z.enum(['full', 'smoke']).default('full'),
  BENCH_DURATION_S: z.coerce.number().int().min(1).optional(),
  BENCH_WARMUP_S: z.coerce.number().int().min(0).optional(),
});

/** A database login used by the benchmark. */
export interface Login {
  user: string;
  password: string;
}

/**
 * hatti_app, where row-level security applies, and a login with the same grants that bypasses it,
 * so the two differ only in whether the policies run.
 */
export const LOGINS = {
  rls: TEST_LOGINS.app,
  bypass: { user: 'hatti_bench_bypass', password: 'hatti_bench_bypass' },
} as const satisfies Record<string, Login>;

export type LoginName = keyof typeof LOGINS;
export type Path = 'direct' | 'pooled';

export interface Settings {
  adminUrl: string;
  database: string;
  poolerUrl: string | undefined;
  scale: 'full' | 'smoke';
  durationS: number;
  warmupS: number;
  /** Superuser on the benchmark database. */
  benchAdminUrl: string;
  url(login: LoginName | Login, path: Path): string;
}

export function loadSettings(): Settings {
  const config = parseEnv(schema);
  const smoke = config.BENCH_SCALE === 'smoke';
  const benchAdminUrl = withDatabase(config.DATABASE_ADMIN_URL, config.BENCH_DATABASE);
  return {
    adminUrl: config.DATABASE_ADMIN_URL,
    database: config.BENCH_DATABASE,
    poolerUrl: config.BENCH_POOLER_URL,
    scale: config.BENCH_SCALE,
    durationS: config.BENCH_DURATION_S ?? (smoke ? 2 : 15),
    warmupS: config.BENCH_WARMUP_S ?? (smoke ? 1 : 3),
    benchAdminUrl,
    url(login, path) {
      const { user, password } = typeof login === 'string' ? LOGINS[login] : login;
      if (path === 'pooled' && !config.BENCH_POOLER_URL) {
        throw new Error('BENCH_POOLER_URL is not set');
      }
      const server = path === 'direct' ? config.DATABASE_ADMIN_URL : config.BENCH_POOLER_URL!;
      return withCredentials(withDatabase(server, config.BENCH_DATABASE), user, password);
    },
  };
}
