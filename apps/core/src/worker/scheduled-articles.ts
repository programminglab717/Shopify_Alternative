import type { Logger } from '@hatti/logger';
import type { ArticleService } from '@hatti/online-store/public';
import { repeat } from './repeat.js';

/**
 * Shows the articles published at a time ahead once it comes (ADR-215): each sweep, the shops
 * with such articles, found with the system role, each shown in its own transaction with its
 * `article.updated`, which the storefront's publisher follows. One shop's failure is not the
 * others'.
 */
export class ScheduledArticles {
  constructor(
    private readonly articles: Pick<ArticleService, 'shopsWithArticlesDue' | 'showDue'>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many articles it showed. */
  async sweep(): Promise<number> {
    let shown = 0;
    for (const shopId of await this.articles.shopsWithArticlesDue()) {
      try {
        const count = await this.articles.showDue(shopId);
        if (count > 0) this.logger?.info({ shopId, shown: count }, 'scheduled articles shown');
        shown += count;
      } catch (error) {
        // Tried again on the next sweep.
        this.logger?.warn({ err: error, shopId }, 'scheduled articles not shown');
      }
    }
    return shown;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'scheduled articles sweep failed'),
    );
  }
}
