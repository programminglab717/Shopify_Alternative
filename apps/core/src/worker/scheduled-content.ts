import type { Logger } from '@hatti/logger';
import type { PriceSaleService, ProductService } from '@hatti/catalog/public';
import type { ArticleService, PageService } from '@hatti/online-store/public';
import { repeat } from './repeat.js';

/** What shows a kind of content once its time comes: the shops with some due, and each shop's. */
export interface ScheduledKind {
  shopsDue(): Promise<string[]>;
  showDue(shopId: string): Promise<number>;
}

/**
 * The online store's articles (ADR-215) and pages (ADR-217), and the catalog's products
 * (ADR-441) and sales set ahead (ADR-443), as the sweep shows, starts or ends them.
 */
export function scheduledKinds(
  articles: Pick<ArticleService, 'shopsWithArticlesDue' | 'showDue'>,
  pages: Pick<PageService, 'shopsWithPagesDue' | 'showDue'>,
  products: Pick<ProductService, 'shopsWithProductsDue' | 'publishDue'>,
  sales: Pick<PriceSaleService, 'shopsWithSalesDue' | 'runDue'>,
): Record<string, ScheduledKind> {
  return {
    articles: {
      shopsDue: () => articles.shopsWithArticlesDue(),
      showDue: (shop) => articles.showDue(shop),
    },
    pages: { shopsDue: () => pages.shopsWithPagesDue(), showDue: (shop) => pages.showDue(shop) },
    products: {
      shopsDue: () => products.shopsWithProductsDue(),
      showDue: (shop) => products.publishDue(shop),
    },
    sales: { shopsDue: () => sales.shopsWithSalesDue(), showDue: (shop) => sales.runDue(shop) },
  };
}

/**
 * Shows the articles, pages and products published at a time ahead once it comes (ADR-215,
 * ADR-217, ADR-441), and starts and ends sales set ahead (ADR-443): each sweep, the shops with
 * some due, found with the system role, each in its own transaction with its `article.updated`,
 * `page.updated` or `product.updated`, which the storefront's publisher follows. One shop's
 * failure is not the others'.
 */
export class ScheduledContent {
  constructor(
    private readonly kinds: Record<string, ScheduledKind>,
    private readonly logger?: Logger,
  ) {}

  /** One sweep: how many of each kind it showed. */
  async sweep(): Promise<Record<string, number>> {
    const shown: Record<string, number> = {};
    for (const [kind, scheduled] of Object.entries(this.kinds)) {
      shown[kind] = 0;
      for (const shopId of await scheduled.shopsDue()) {
        try {
          const count = await scheduled.showDue(shopId);
          if (count > 0)
            this.logger?.info({ shopId, kind, shown: count }, 'scheduled content shown');
          shown[kind] += count;
        } catch (error) {
          // Tried again on the next sweep.
          this.logger?.warn({ err: error, shopId, kind }, 'scheduled content not shown');
        }
      }
    }
    return shown;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'scheduled content sweep failed'),
    );
  }
}
