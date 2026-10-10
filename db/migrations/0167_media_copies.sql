-- 0167 · Products' photos and videos copied with a product duplicated
-- A product duplicated with its photos and videos (CAT-01) has each made again for its copy. The
-- file the shop uploaded is swept a day after, so the copy is made from what was kept of the one
-- it copies, its clean copy, video and crop, where it is still there; from its source otherwise.
-- See ADR-343 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.product_media
  -- The media this is a copy of, as it was when copied; null for one of its own. Not a reference:
  -- the one it copies may go, and the copy is made from its source then.
  ADD COLUMN copied_from uuid;
