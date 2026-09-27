-- 0001 · Foundation
-- Roles, schemas, tenant isolation helpers, shop directory, access tokens, catalog, outbox.
-- See docs/architecture/03-multi-tenancy-and-data.md and docs/engineering/conventions.md.

-- ---------------------------------------------------------------------------------------------
-- Roles
-- Group roles hold privileges. Login users (hatti_app, hatti_system) are created per environment
-- and granted one of these; `pnpm db:setup` does that for local development.
--   hatti_app_role     request-serving code. Row-level security limits it to the current shop.
--   hatti_system_role  cell-wide jobs (outbox relay, maintenance). Sees every shop; audited.
-- Roles are cluster-wide, so creation tolerates concurrent migrations of other databases.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  CREATE ROLE hatti_app_role NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE hatti_system_role NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

-- On managed Postgres the migrating user is not a superuser; it needs membership to hand
-- ownership of SECURITY DEFINER functions to hatti_system_role.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND NOT pg_has_role(current_user, 'hatti_system_role', 'MEMBER') THEN
    EXECUTE format('GRANT hatti_system_role TO %I', current_user);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Schemas: one per module, plus platform (infrastructure) and control (shop directory, owned by
-- the control plane and replicated read-only into cells in production).
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA control;
CREATE SCHEMA apps;
CREATE SCHEMA catalog;

GRANT USAGE ON SCHEMA platform, control, apps, catalog TO hatti_app_role, hatti_system_role;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Time-ordered UUID (RFC 9562 version 7). Native uuidv7() arrives in Postgres 18; the application
-- normally generates IDs itself, this is for SQL defaults and backfills.
CREATE FUNCTION platform.uuidv7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

-- The shop the current transaction acts for, set with set_config('app.shop_id', …, true).
-- Unset reads back as '' rather than NULL once an earlier local setting has ended, hence NULLIF.
-- NULL matches no rows, so forgetting to set it fails closed.
CREATE FUNCTION platform.current_shop_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid
$$;

-- Makes a table tenant-scoped: request-serving sessions see and write only the current shop's rows,
-- the system role sees all rows. FORCE applies the policies to the table owner too.
CREATE FUNCTION platform.enable_tenant_isolation(tbl regclass, tenant_column name DEFAULT 'shop_id')
  RETURNS void
  LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s TO hatti_app_role '
      'USING (%I = platform.current_shop_id()) WITH CHECK (%I = platform.current_shop_id())',
    tbl, tenant_column, tenant_column
  );
  EXECUTE format(
    'CREATE POLICY system_access ON %s TO hatti_system_role USING (true) WITH CHECK (true)',
    tbl
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO hatti_app_role, hatti_system_role',
    tbl
  );
END
$$;

REVOKE ALL ON FUNCTION platform.enable_tenant_isolation(regclass, name) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.uuidv7(), platform.current_shop_id()
  TO hatti_app_role, hatti_system_role;

-- ---------------------------------------------------------------------------------------------
-- control.shops: the shop directory. Tenants can read and rename their own shop, never create or
-- delete shops.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE control.shops (
  id         uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  status     text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended', 'closed')),
  currency   text        NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  timezone   text        NOT NULL DEFAULT 'Asia/Karachi',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('control.shops', 'id');
REVOKE INSERT, DELETE ON control.shops FROM hatti_app_role;

-- ---------------------------------------------------------------------------------------------
-- apps.access_tokens: Admin API tokens. Only a SHA-256 hash of the secret is stored; the secret is
-- shown once at creation.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE apps.access_tokens (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  token_hash   bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  token_hint   text        NOT NULL,
  scopes       text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  PRIMARY KEY (shop_id, id)
);

-- Tokens are looked up before the shop is known, so this index cannot lead with shop_id.
CREATE UNIQUE INDEX access_tokens_token_hash_key ON apps.access_tokens (token_hash);

SELECT platform.enable_tenant_isolation('apps.access_tokens');

-- Resolves a token hash to its shop and scopes. SECURITY DEFINER lets request code look a token up
-- without seeing any other token; it returns nothing for revoked or expired tokens and for shops
-- that are not active.
CREATE FUNCTION platform.resolve_access_token(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, token_id uuid, scopes text[], shop_currency text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.shop_id, t.id, t.scopes, s.currency
    FROM apps.access_tokens t
    JOIN control.shops s ON s.id = t.shop_id
   WHERE t.token_hash = p_token_hash
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND s.status = 'active'
$$;

ALTER FUNCTION platform.resolve_access_token(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION platform.resolve_access_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.resolve_access_token(bytea) TO hatti_app_role;

-- ---------------------------------------------------------------------------------------------
-- catalog: products and variants. Primary keys lead with shop_id so every index serves tenant
-- filters and a shop's rows can be copied by range when it moves cells.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE catalog.products (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  title        text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  handle       text        NOT NULL
                           CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(handle) <= 255),
  status       text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'active', 'archived')),
  description  text        NOT NULL DEFAULT '',
  vendor       text,
  product_type text,
  tags         text[]      NOT NULL DEFAULT '{}',
  -- Normalised by searchKey() in @hatti/pk, so Roman Urdu spellings and Urdu script variants match.
  search_text  text        NOT NULL DEFAULT '',
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT products_shop_handle_key UNIQUE (shop_id, handle)
);

CREATE INDEX products_shop_updated_idx ON catalog.products (shop_id, updated_at DESC, id DESC);

SELECT platform.enable_tenant_isolation('catalog.products');

CREATE TABLE catalog.variants (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id       uuid        NOT NULL,
  title            text        NOT NULL DEFAULT 'Default',
  sku              text,
  barcode          text,
  -- Minor units (paisa) in the shop currency.
  price            bigint      NOT NULL CHECK (price >= 0),
  compare_at_price bigint      CHECK (compare_at_price >= 0),
  position         integer     NOT NULL DEFAULT 1 CHECK (position >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  -- Including shop_id makes it impossible to attach a variant to another shop's product.
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX variants_shop_product_idx ON catalog.variants (shop_id, product_id, position);

SELECT platform.enable_tenant_isolation('catalog.variants');

-- ---------------------------------------------------------------------------------------------
-- platform.outbox_events: domain events written in the same transaction as the change they
-- describe, then relayed to the queue. Request code may only append; the relay (system role)
-- reads and marks rows. Daily partitions come later, when volume needs them.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE platform.outbox_events (
  id             uuid        PRIMARY KEY,
  shop_id        uuid        NOT NULL,
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text
);

CREATE INDEX outbox_events_unpublished_idx
  ON platform.outbox_events (occurred_at, id)
  WHERE published_at IS NULL;

ALTER TABLE platform.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_append ON platform.outbox_events
  FOR INSERT TO hatti_app_role
  WITH CHECK (shop_id = platform.current_shop_id());

CREATE POLICY system_access ON platform.outbox_events
  TO hatti_system_role
  USING (true) WITH CHECK (true);

GRANT INSERT ON platform.outbox_events TO hatti_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.outbox_events TO hatti_system_role;

-- Wakes the relay as soon as events commit, instead of waiting for its next poll.
CREATE FUNCTION platform.notify_outbox() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('hatti_outbox', '');
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_events_notify
  AFTER INSERT ON platform.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_outbox();
