-- 0017 · Idempotency keys
-- A client sends an Idempotency-Key header with a mutation so that retrying it after a timeout
-- cannot do the work twice: the first answer is kept here for a day, and a retry with the same
-- key gets it back. Keys belong to the caller that sent them. See
-- docs/architecture/08-api-and-app-platform.md and docs/engineering/conventions.md.

CREATE TABLE platform.idempotency_keys (
  shop_id      uuid        NOT NULL,
  -- The access token or staff member that sent the key.
  actor_id     uuid        NOT NULL,
  key          text        NOT NULL CHECK (key ~ '^[!-~]{1,255}$'),
  -- SHA-256 of the request: the query, operation name and variables. A key sent again with
  -- another request is refused.
  fingerprint  bytea       NOT NULL CHECK (length(fingerprint) = 32),
  -- Null while the first request runs, then the HTTP status and body it answered.
  status_code  smallint    CHECK (status_code BETWEEN 100 AND 599),
  response     text,
  -- A request that dies leaves its key held until then; another request may then take it over.
  locked_until timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (shop_id, actor_id, key),
  CONSTRAINT idempotency_keys_response_check CHECK ((status_code IS NULL) = (response IS NULL))
);

-- Each claim sweeps its shop's expired keys.
CREATE INDEX idempotency_keys_expiry_idx ON platform.idempotency_keys (shop_id, expires_at);

SELECT platform.enable_tenant_isolation('platform.idempotency_keys');
