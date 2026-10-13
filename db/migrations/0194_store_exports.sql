-- 0194 · The whole store exported (ADM-10)
-- An owner asks for one file of everything the shop keeps: a ZIP of its products, stock,
-- customers, orders and redirects, each in the format its own export writes, which a worker
-- makes in the background and storage keeps for a week behind short-lived signed links. See
-- ADR-415 in docs/architecture/13-decision-log.md.

CREATE TABLE files.store_exports (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  -- The owner who asked: the export is made as them, and only while they are still an owner.
  requested_by uuid        NOT NULL,
  -- Made once ready; expired once storage let it go.
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  -- Where storage keeps the ZIP while ready: shops/{shopId}/exports/{id}.zip.
  key          text,
  -- Bytes of the ZIP.
  size         bigint,
  -- Why it failed, in words for the owner.
  error        text,
  -- Tries so far; a worker holds a pending one until lease_until, then another may try.
  attempts     integer     NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- When storage lets the ZIP go: a week after it is ready.
  expires_at   timestamptz,
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'ready') = (key IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('files.store_exports');

-- The worker's sweeps across shops: those waiting, and those whose ZIPs are to go.
CREATE INDEX store_exports_pending ON files.store_exports (created_at) WHERE status = 'pending';
CREATE INDEX store_exports_expiring ON files.store_exports (expires_at) WHERE status = 'ready';
