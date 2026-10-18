-- 0267 · The filters a shop chooses
-- A shop chooses which of its storefront's filters its collection and search pages show, in what
-- order and under what words (SRC-03), as Shopify's Search & Discovery app lets it, and may add
-- filters of its products' and variants' metafields. See ADR-568 in
-- docs/architecture/13-decision-log.md.

-- Each filter in its order, as the online store checked it: its kind, the option or metafield it
-- is of, and its own words in English and Urdu, null for the platform's. Null while the shop chose
-- none: every filter the platform has, in its order.
ALTER TABLE online_store.preferences
  ADD COLUMN storefront_filters jsonb
    CHECK (storefront_filters IS NULL OR (jsonb_typeof(storefront_filters) = 'array'
                                           AND jsonb_array_length(storefront_filters) <= 25));
