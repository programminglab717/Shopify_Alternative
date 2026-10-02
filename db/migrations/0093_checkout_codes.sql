-- 0093 · One-time codes at checkout
-- Checkout asks a shopper paying on delivery to prove the number they typed with a code sent to
-- it on WhatsApp, or by SMS (CHK-09), where the shop's risk rules score the order at the shop's
-- mark or above. Only a digest of each code is kept, with its tries, until its checkout goes. An
-- order placed after the number was proved keeps when it was.
-- See ADR-148 in docs/architecture/13-decision-log.md.

-- The score, 0 to 100, from which the shop asks for a code: 0 for every order paid on delivery.
ALTER TABLE checkout.cod_settings
  ADD COLUMN verify_from smallint CHECK (verify_from BETWEEN 0 AND 100);

CREATE TABLE checkout.number_codes (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  checkout_id uuid        NOT NULL,
  -- E.164: the number it went to, which it proves.
  phone       text        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  channel     text        NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  -- SHA-256 of the code with the row's ID.
  code_hash   bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts    smallint    NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, checkout_id) REFERENCES checkout.checkouts (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('checkout.number_codes');

CREATE INDEX number_codes_checkout ON checkout.number_codes (shop_id, checkout_id, created_at DESC);
-- How many codes a number was sent lately, across the shop's checkouts.
CREATE INDEX number_codes_phone ON checkout.number_codes (shop_id, phone, created_at DESC);

ALTER TABLE orders.orders ADD COLUMN phone_verified_at timestamptz;
