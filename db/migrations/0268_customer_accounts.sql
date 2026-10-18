-- 0268 · Shoppers' accounts, signed in to by a code
-- A shopper signs in to a shop's storefront with their mobile number and a one-time code sent to
-- it on WhatsApp, or by SMS (CUS-02), as Shopify's customer accounts sign in by a code: checkout's
-- codes (CHK-09), with checkout's limits on how many a number and an internet address are sent,
-- but kept apart by their purpose, so that a code sent to sign in places no order and one sent at
-- checkout signs no one in. A sign-in code goes a day after it was sent, once it no longer counts
-- towards the number's codes for the day. The code proved gives the browser a session: a random
-- token its cookie keeps, of which the shop keeps only a digest, with the number it proved and the
-- customer the number was theirs then. A session lasts 30 days from when it was last used, and 90
-- at most from sign-in; signing out, or the customer's erasure, ends it. It keeps the links of the
-- order pages it opened, as messages keep those they carry, so that opening one again gives the
-- same link. Through it the storefront reads the shopper's account: the customer's orders with
-- the shop and their store credit. See ADR-570 in docs/architecture/13-decision-log.md.

-- What a code is for: proving the number in a checkout, which it goes with, or signing in.
ALTER TABLE checkout.number_codes
  ADD COLUMN purpose text NOT NULL DEFAULT 'checkout' CHECK (purpose IN ('checkout', 'sign_in'));
ALTER TABLE checkout.number_codes ALTER COLUMN checkout_id DROP NOT NULL;
ALTER TABLE checkout.number_codes
  ADD CONSTRAINT number_codes_purpose_checkout
    CHECK ((purpose = 'checkout') = (checkout_id IS NOT NULL));

-- Sign-in codes past their day, cleared by the worker's sweep.
CREATE INDEX number_codes_sign_in_expiry ON checkout.number_codes (expires_at)
  WHERE purpose = 'sign_in';

CREATE TABLE checkout.account_sessions (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- SHA-256 of the token the browser keeps.
  token_hash   bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  -- E.164: the number its code proved, whose customer's account it reads.
  phone        text        NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- The customer the number was theirs when last read; null while it was no one's.
  customer_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- 30 days from when it was last used, moved at most hourly, and 90 at most from sign-in.
  expires_at   timestamptz NOT NULL CHECK (expires_at <= created_at + interval '90 days'),
  -- Signed out: it reads nothing, and the sweep deletes it.
  revoked_at   timestamptz,
  -- The secrets of the order pages it opened (ADR-050), by order ID, as messages keep the links
  -- they carry (ADR-160): opening one again keeps the order's link while it is still the order's.
  order_links  jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(order_links) = 'object'),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_hash)
);

SELECT platform.enable_tenant_isolation('checkout.account_sessions');

-- A number's and a customer's sessions, which their erasure ends.
CREATE INDEX account_sessions_phone ON checkout.account_sessions (shop_id, phone);
CREATE INDEX account_sessions_customer ON checkout.account_sessions (shop_id, customer_id)
  WHERE customer_id IS NOT NULL;
-- Those lapsed or signed out, cleared by the worker's sweep.
CREATE INDEX account_sessions_expiry ON checkout.account_sessions (expires_at);
