-- 0378 · Apps' functions (DEV-07, CHK-20)
-- An app, custom or public, gives the shop a function: a WebAssembly module, 256 KiB at most,
-- that checkout runs on what it is about to offer, as Shopify's functions run. A payment
-- customisation hides ways to pay: cash on delivery above an amount, or to a city. A cart
-- validation refuses an order, saying why. The shop's owner or a manager turns each on and gives
-- it its settings; the app may send a new version, which runs as the old one did. One whose app is
-- removed or uninstalled goes with it. See ADR-868 in docs/architecture/13-decision-log.md.

CREATE TABLE apps.app_functions (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  token_id      uuid        NOT NULL,
  -- The app's own name for it, unique among its functions: "cod-above-limit".
  handle        text        NOT NULL CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                                            AND char_length(handle) <= 50),
  title         text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  target        text        NOT NULL CHECK (target IN ('payment_customization', 'cart_validation')),
  -- The module as it runs, its memory's maximum capped at 10 MiB, and its SHA-256.
  wasm          bytea       NOT NULL CHECK (octet_length(wasm) <= 262144),
  wasm_digest   bytea       NOT NULL,
  -- Off until the shop turns it on; its settings, as the function reads them.
  enabled       boolean     NOT NULL DEFAULT false,
  configuration jsonb       NOT NULL DEFAULT '{}'::jsonb
                            CHECK (octet_length(configuration::text) <= 10000),
  -- Its last failure, for the shop and the app to see: a run past its time, or no answer.
  last_error    text        CHECK (char_length(last_error) <= 500),
  failed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_id, handle),
  FOREIGN KEY (shop_id, token_id) REFERENCES apps.access_tokens (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('apps.app_functions');
