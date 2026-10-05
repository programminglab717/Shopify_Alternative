-- 0127 · A browser that proved a number lately (CHK-09)
-- A shopper who proved the number they typed with a code at a shop's checkout is not asked for
-- another for it from the same browser for 30 days, where the shop's risk rules would ask: the
-- browser keeps a random token in a cookie, and the shop keeps only its digest, with the number
-- it proves and when that was. Spending store credit still asks for a code each time.
-- See ADR-199 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.number_proofs (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- SHA-256 of the token the browser keeps.
  token_hash bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  -- E.164: the number its code proved.
  phone      text        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  proved_at  timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > proved_at),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_hash)
);

SELECT platform.enable_tenant_isolation('checkout.number_proofs');

-- Those lapsed, cleared as new ones are made.
CREATE INDEX number_proofs_expiry ON checkout.number_proofs (shop_id, expires_at);
