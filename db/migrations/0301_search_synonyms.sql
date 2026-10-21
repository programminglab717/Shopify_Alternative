-- 0301 · A shop's own search synonyms
-- A storefront's search finds what a word means in English, Roman Urdu or Urdu through Hatti's
-- commerce lexicon (ADR-481); a shop may now keep words of its own that mean the same, "chappal"
-- its "sandals", which the search reads beside the lexicon. See ADR-685 in
-- docs/architecture/13-decision-log.md.

-- The shop's groups of words that mean the same, all of them in one row, replaced together.
CREATE TABLE catalog.search_synonyms (
  shop_id    uuid        PRIMARY KEY,
  -- Each group as the shop wrote it: [{"words": ["chappal", "sandals"]}, ...].
  groups     jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(groups) = 'array'),
  -- Each group's words as the search folds them, a group to a string of words between spaces,
  -- " chappal sandal ", to find a word's group with one LIKE.
  keys       text[]      NOT NULL DEFAULT '{}',
  version    integer     NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('catalog.search_synonyms');
