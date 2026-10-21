-- 0306 · A theme published at a time set ahead
-- The Eid look prepared in an unpublished theme goes live at the minute the shop chooses, by the
-- worker, as products and pages set ahead do (OS-03). See ADR-695 in
-- docs/architecture/13-decision-log.md.

-- When the worker publishes the theme; null when it is not set ahead.
ALTER TABLE online_store.themes ADD COLUMN publish_at timestamptz;

-- The sweep finds the themes whose time came across shops.
CREATE INDEX themes_publish_at_idx ON online_store.themes (publish_at) WHERE publish_at IS NOT NULL;
