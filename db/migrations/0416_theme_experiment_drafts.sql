-- 0416 · Theme experiments with several drafts (OS-22)
-- An experiment may show up to three drafts, each its own share of shoppers, the live theme never
-- fewer than any: the first stays `theme_id`, arm b; the others are arms c and d, in turn. Each
-- draft is compared with the live theme at a confidence split among them, and any draft selling
-- clearly worse ends it. See ADR-931 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.theme_experiments
  ADD COLUMN other_theme_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(other_theme_ids) <= 2 AND NOT theme_id = ANY (other_theme_ids)),
  ADD CHECK (share * (cardinality(other_theme_ids) + 2) <= 100);
