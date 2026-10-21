-- 0305 · A theme's versions
-- Each change to a theme's own files keeps what the files it touched were before it, so the
-- theme can be taken back to the version a change made: the Eid look undone after Eid, a bad
-- save undone at once (OS-03). See ADR-694 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.theme_versions (
  shop_id    uuid        NOT NULL,
  theme_id   uuid        NOT NULL,
  -- The theme's version the change made.
  version    integer     NOT NULL CHECK (version >= 1),
  -- The files the change touched, as they were before it, by filename; null where the theme
  -- had none of its own and the platform theme's showed.
  before     jsonb       NOT NULL CHECK (jsonb_typeof(before) = 'object'),
  -- What made the change: files saved, files deleted, or the theme taken back.
  cause      text        NOT NULL CHECK (cause IN ('saved', 'deleted', 'rolled_back')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, theme_id, version),
  FOREIGN KEY (shop_id, theme_id) REFERENCES online_store.themes (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('online_store.theme_versions');
