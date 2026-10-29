import type { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import type { Logger } from '@hatti/logger';
import {
  endExperimentIn,
  guardrailTripped,
  recordExperimentResultsIn,
} from '@hatti/online-store/public';
import type { StorefrontActivity } from '@hatti/storefront-data';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';

/**
 * Shops' running theme experiments (OS-22, ADR-866): each arm's counts taken from the
 * storefronts' and kept, and an experiment ended on its last day, or as soon as a draft of it
 * sells clearly worse than the live theme (ADR-931), so a shop never loses much to one.
 */
export class ThemeExperiments {
  constructor(
    private readonly database: Database,
    private readonly activity: Pick<StorefrontActivity, 'experimentCounts'>,
    private readonly logger?: Pick<Logger, 'warn' | 'info'>,
  ) {}

  /** One sweep at `at`: the experiments ended, and why. */
  async sweep(at: Date = new Date()): Promise<{ id: string; reason: 'time' | 'guardrail' }[]> {
    const { rows } = await this.database.system((tx) =>
      tx.execute<{ shop_id: string; id: string; ends_at: Date | string; drafts: number }>(sql`
        SELECT shop_id, id, ends_at, 1 + cardinality(other_theme_ids) AS drafts
          FROM online_store.theme_experiments
         WHERE ended_at IS NULL ORDER BY started_at`),
    );
    const ended: { id: string; reason: 'time' | 'guardrail' }[] = [];
    for (const row of rows) {
      try {
        const results = await this.activity.experimentCounts(
          row.shop_id,
          toPublicId('themeExperiment', row.id),
          Number(row.drafts),
        );
        const reason = guardrailTripped(results)
          ? ('guardrail' as const)
          : new Date(row.ends_at) <= at
            ? ('time' as const)
            : null;
        await this.database.tenant(row.shop_id, async (tx) => {
          await recordExperimentResultsIn(tx, row.shop_id, row.id, results);
          if (reason) await endExperimentIn(tx, row.shop_id, reason, { id: row.id });
        });
        if (reason) {
          ended.push({ id: row.id, reason });
          this.logger?.info(
            { shopId: row.shop_id, experimentId: row.id, reason },
            'theme experiment ended',
          );
        }
      } catch (error) {
        this.logger?.warn({ err: error, shopId: row.shop_id }, 'theme experiment not counted');
      }
    }
    return ended;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'theme experiments sweep failed'),
    );
  }
}
