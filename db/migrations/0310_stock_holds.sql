-- 0310 · Stock held while a shopper checks out
-- A shop may hold a cart's stock for some minutes once its shopper starts checking out, so that
-- in a drop the last pieces go to whoever reached checkout first, not to whoever pressed "Place
-- order" first (CHK-02). The units are reserved at the location the order would ship from, given
-- back when the order takes them, when another checkout of the cart begins, or when the minutes
-- run out. See ADR-715 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.hold_settings (
  shop_id    uuid        PRIMARY KEY,
  -- How long a checkout holds its cart's stock; none for no holds.
  minutes    smallint    CHECK (minutes BETWEEN 5 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT platform.enable_tenant_isolation('checkout.hold_settings');

ALTER TABLE checkout.checkouts
  -- The units it holds, [{variantId, locationId, quantity}], and until when.
  ADD COLUMN held jsonb,
  ADD COLUMN held_until timestamptz,
  ADD CONSTRAINT checkouts_held_check CHECK ((held IS NULL) = (held_until IS NULL));

-- The sweep's: holds whose minutes ran out, across shops.
CREATE INDEX checkouts_held_until_idx ON checkout.checkouts (held_until)
  WHERE held_until IS NOT NULL;
