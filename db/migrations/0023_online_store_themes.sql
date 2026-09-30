-- 0023 · Online store themes
-- A shop's themes: a platform theme, such as Hatti Base, with the shop's own JSON files over it,
-- its templates, section groups and settings. The main theme is the one its storefront shows; the
-- others are being prepared. Liquid, assets and translations stay the platform theme's until
-- shops can edit code. See ADR-039 in docs/architecture/13-decision-log.md.

CREATE SCHEMA online_store;

GRANT USAGE ON SCHEMA online_store TO hatti_app_role, hatti_system_role;

CREATE TABLE online_store.themes (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The platform theme it is built on, such as hatti-base.
  base       text        NOT NULL CHECK (base ~ '^[a-z0-9-]{1,40}$'),
  role       text        NOT NULL CHECK (role IN ('main', 'unpublished')),
  -- Goes up with every change, so a storefront knows its copy is out of date.
  version    integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- A shop has one main theme.
CREATE UNIQUE INDEX themes_main_key ON online_store.themes (shop_id) WHERE role = 'main';

SELECT platform.enable_tenant_isolation('online_store.themes');

CREATE TABLE online_store.theme_files (
  shop_id    uuid        NOT NULL,
  theme_id   uuid        NOT NULL,
  -- templates/<name>.json, sections/<group>.json or config/settings_data.json.
  filename   text        NOT NULL CHECK (
               filename ~ '^(templates/[a-z0-9_-]+(\.[a-z0-9_-]+)?|sections/[a-z0-9_-]+|config/settings_data)\.json$'
             ),
  body       text        NOT NULL CHECK (octet_length(body) <= 262144),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, theme_id, filename),
  FOREIGN KEY (shop_id, theme_id) REFERENCES online_store.themes (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('online_store.theme_files');
