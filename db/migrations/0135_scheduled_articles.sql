-- 0135 · Articles published at a time ahead
-- An article whose published_at is ahead is scheduled, as Shopify's publishDate makes one: hidden
-- until then, as the storefront, its search and menus' links compare it with now. `scheduled` is
-- true until the worker shows it, announcing it once with its article.updated event when its
-- time comes. See ADR-215 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.articles
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false;

-- The articles whose time comes, as the worker finds them.
CREATE INDEX articles_scheduled_idx
  ON online_store.articles (published_at) WHERE scheduled;
