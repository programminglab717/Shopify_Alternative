-- 0365 · App embeds (DEV-06)
-- An app, custom or public, offers the shop's storefront a script of its own: a reviews widget,
-- a chat, a size finder. The app names it and gives its https address; the shop's owner or a
-- manager turns it on, as Shopify's theme app embeds are turned on in the theme editor. A script
-- on whose app is removed or uninstalled stops loading with it. See ADR-852 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE apps.app_embeds (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The app offering it: its access token, as an install is one (ADR-851).
  token_id   uuid        NOT NULL,
  -- The app's own name for it, unique among its embeds: "reviews-widget".
  handle     text        NOT NULL CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                                         AND char_length(handle) <= 50),
  name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  src        text        NOT NULL CHECK (src ~ '^https://' AND char_length(src) <= 500),
  -- Off until the shop turns it on.
  enabled    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_id, handle),
  FOREIGN KEY (shop_id, token_id) REFERENCES apps.access_tokens (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('apps.app_embeds');
