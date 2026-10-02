-- 0105 · Link pages
-- A shop's link-in-bio page (CH-07): what it says of itself, links of its own and the products it
-- chooses, each with a way to buy at once, which the storefront shows at /links for its Instagram
-- and TikTok bios and its chats. Kept with the shop's storefront preferences and published in its
-- storefront document. See ADR-161 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  -- A line or two about the shop, as typed.
  ADD COLUMN link_bio      text   NOT NULL DEFAULT '' CHECK (char_length(link_bio) <= 300),
  -- Its own links, in their order: [{"title": "Sale", "url": "/collections/sale"}].
  ADD COLUMN link_links    jsonb  NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(link_links) = 'array' AND jsonb_array_length(link_links) <= 10),
  -- The products it shows, in their order; those deleted or not on sale are left out.
  ADD COLUMN link_products uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(link_products) <= 24);
