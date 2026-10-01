-- 0049 · Files
-- Files a shop uploads (ADR-079), such as images for its pages and the logo on its checkout: kept
-- in object storage under the shop's own prefix, uploaded straight there through a URL the Admin
-- API signs, as Shopify's staged uploads are, and made a file once the upload is in and is what
-- it said it was. A row for each upload, staged until then. See ADR-079 in
-- docs/architecture/13-decision-log.md.

CREATE SCHEMA files;

GRANT USAGE ON SCHEMA files TO hatti_app_role, hatti_system_role;

CREATE TABLE files.files (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  -- Where storage keeps it: shops/{shop_id}/files/{id}/{name}.
  key          text        NOT NULL CHECK (key LIKE 'shops/' || shop_id || '/files/' || id || '/%'),
  filename     text        NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text        NOT NULL
               CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif',
                                       'application/pdf')),
  -- Bytes; at most 20 MiB, what one upload may weigh.
  size         integer     NOT NULL CHECK (size BETWEEN 1 AND 20971520),
  alt          text        NOT NULL DEFAULT '' CHECK (length(alt) <= 512),
  -- Staged until its upload is in and checked; then ready.
  status       text        NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'ready')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT files_key_key UNIQUE (shop_id, key)
);

-- Staged uploads never made files, oldest first, for the sweep as a shop stages more.
CREATE INDEX files_staged ON files.files (shop_id, created_at) WHERE status = 'staged';

SELECT platform.enable_tenant_isolation('files.files');
