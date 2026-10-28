-- 0358 · Bulk operations (DEV-10)
-- An app or member of staff asks for all of a list at once (ADR-843): the API runs the query
-- they give a page at a time in the background, as them, and writes every node to a JSONL file
-- in storage, which a link gives for a week. One runs at a time for a shop's caller.
-- See ADR-843 in docs/architecture/13-decision-log.md.

CREATE TABLE apps.bulk_operations (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Who asked: an app's token or a member of staff, as the audit log names them.
  caller       text        NOT NULL CHECK (char_length(caller) BETWEEN 1 AND 200),
  query        text        NOT NULL CHECK (char_length(query) BETWEEN 1 AND 20000),
  status       text        NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'completed', 'failed', 'canceled')),
  object_count integer     NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  -- The file once written, and its bytes.
  file_key     text,
  file_size    integer     CHECK (file_size >= 0),
  -- Why it failed, as the API's error codes say it.
  error_code   text        CHECK (char_length(error_code) <= 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (shop_id, id),
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK ((status = 'completed') = (file_key IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('apps.bulk_operations');

CREATE UNIQUE INDEX bulk_operations_one_running ON apps.bulk_operations (shop_id, caller)
  WHERE status = 'running';
