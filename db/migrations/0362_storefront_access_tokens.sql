-- 0362 · Storefront access tokens (DEV-02)
-- The Storefront API (ADR-848) answers headless storefronts and shopping apps with a token of the
-- shop's: public ones, sent from shoppers' browsers, and private ones, kept on a server. Each is
-- shown once when it is made and kept here as its digest, with its last characters to tell it
-- by; the shop's storefront document carries the digests, which the storefront checks.
-- See ADR-848 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.storefront_access_tokens (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  title        text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  -- Public tokens may be seen by anyone who loads a page; private ones stay on a server.
  kind         text        NOT NULL CHECK (kind IN ('public', 'private')),
  -- SHA-256 of the token.
  token_digest bytea       NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  token_hint   text        NOT NULL CHECK (char_length(token_hint) = 4),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('online_store.storefront_access_tokens');
