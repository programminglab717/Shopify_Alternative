-- 0399 · Combined listings as one card
-- A combined listing a shop shows as one card in its collections (CAT-23): the first of its
-- products in each collection's order stands for the rest, whose values its card names. See
-- ADR-901 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.combined_listings ADD COLUMN one_card boolean NOT NULL DEFAULT false;
