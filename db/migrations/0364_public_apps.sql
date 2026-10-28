-- 0364 · Public apps (DEV-05)
-- A partner (ADR-504) registers an app that shops install: its name, its address, where it may
-- send merchants back to, and the scopes it asks for, with a client ID and a secret shown once
-- and kept as its digest. An owner or a manager approves it for their shop, as Shopify's OAuth
-- has them do; Hatti gives the app a code, which it trades with its secret for a token of the
-- shop's, as a custom app's (ADR-395), its webhooks signed with that secret. Until Hatti lists
-- it, an app installs on its partner's development stores alone. See ADR-851 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE identity.partner_apps (
  id                   uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  partner_id           uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  name                 text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  app_url              text        NOT NULL CHECK (app_url ~ '^https://' AND char_length(app_url) <= 300),
  -- Where merchants are sent back with a code: each https, one to five.
  redirect_urls        text[]      NOT NULL CHECK (cardinality(redirect_urls) BETWEEN 1 AND 5),
  scopes               text[]      NOT NULL CHECK (cardinality(scopes) >= 1),
  client_id            text        NOT NULL UNIQUE CHECK (client_id ~ '^hca_[0-9a-f]{32}$'),
  -- SHA-256 of the client secret, which is shown once.
  client_secret_digest bytea       NOT NULL CHECK (octet_length(client_secret_digest) = 32),
  -- When Hatti reviewed it and listed it for every shop; null while it is the partner's alone.
  listed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX partner_apps_partner_idx ON identity.partner_apps (partner_id, created_at);

-- A merchant's approval of an app for their shop: a code, kept as its digest, which the app
-- trades for a token within ten minutes, once.
CREATE TABLE identity.app_authorizations (
  code_digest  bytea       PRIMARY KEY CHECK (octet_length(code_digest) = 32),
  app_id       uuid        NOT NULL REFERENCES identity.partner_apps (id) ON DELETE CASCADE,
  shop_id      uuid        NOT NULL REFERENCES control.shops (id),
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  scopes       text[]      NOT NULL,
  redirect_uri text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.partner_apps, identity.app_authorizations
  TO hatti_identity_role;

-- An install is an access token of the shop's, naming its app.
ALTER TABLE apps.access_tokens ADD COLUMN public_app_id uuid;

CREATE INDEX access_tokens_public_app_idx ON apps.access_tokens (shop_id, public_app_id)
  WHERE public_app_id IS NOT NULL AND revoked_at IS NULL;
