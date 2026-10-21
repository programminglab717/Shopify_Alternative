-- 0307 · Theme preview links taken back
-- A preview link sent to the wrong person, or a theme no longer to be shown, has every link made
-- so far ended at once: a link holds its theme's links' generation, and shows the theme only while
-- the theme is at it still (OS-02). See ADR-699 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.themes ADD COLUMN preview_generation integer NOT NULL DEFAULT 0;
