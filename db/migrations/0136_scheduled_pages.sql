-- 0136 · Pages published at a time ahead
-- A page whose published_at is ahead is scheduled, as Shopify's publishDate makes one, as an
-- article is (0135): hidden until then, and `scheduled` until the worker shows it, announcing it
-- once with its page.updated. See ADR-217 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.pages
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false;

-- The pages whose time comes, as the worker finds them.
CREATE INDEX pages_scheduled_idx
  ON online_store.pages (published_at) WHERE scheduled;
