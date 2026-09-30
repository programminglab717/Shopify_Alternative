-- 0031 · Online store URL redirects
-- A shop's redirects from old addresses to new ones, such as its Shopify store's when it moves:
-- the storefront sends an address its shop has no page for on to the redirect's target, as
-- Shopify's URL redirects do. See ADR-052 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.url_redirects (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- A path on the storefront, as redirectPath keeps it: lowercase, without a query, a trailing
  -- slash or the Urdu prefix; never the home page.
  path       text        NOT NULL CHECK (
               length(path) BETWEEN 2 AND 1024 AND path ~ '^/[^?#[:space:]]+$' AND path !~ '/$'
             ),
  -- A path on the storefront, or an http(s) address elsewhere.
  target     text        NOT NULL CHECK (
               length(target) BETWEEN 1 AND 2048 AND target ~ '^(/|https?://)' AND target <> path
             ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

CREATE UNIQUE INDEX url_redirects_path_key ON online_store.url_redirects (shop_id, path);

SELECT platform.enable_tenant_isolation('online_store.url_redirects');
