-- 0146 · A shop's own words for its content in Urdu
-- A product's, collection's, page's, blog's, article's, menu's or menu item's fields in another
-- of the storefront's languages, as Shopify's translations keep them: one row a field in a
-- language, with the digest of the shop's own words it was written for, so the API can say when
-- those have changed since (OS-06). See ADR-238 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.translations (
  shop_id     uuid        NOT NULL,
  -- What it translates: one of the shop's products, collections, pages, blogs, articles, menus
  -- or menu items, by its ID, which says which.
  resource_id uuid        NOT NULL,
  -- A language the storefront shows besides the shop's own.
  locale      text        NOT NULL CHECK (locale IN ('ur')),
  -- The field, by Shopify's name for it.
  key         text        NOT NULL CHECK (key IN ('title', 'body_html', 'summary_html',
                                                  'product_type', 'meta_title',
                                                  'meta_description')),
  value       text        NOT NULL CHECK (value <> '' AND octet_length(value) <= 524288),
  -- SHA-256 of the shop's own words it was written for, in hex.
  digest      text        NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, resource_id, locale, key)
);

SELECT platform.enable_tenant_isolation('online_store.translations');
