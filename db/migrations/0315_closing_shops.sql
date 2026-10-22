-- 0315 · An owner closes their shop
-- A shop's owner closes it from the admin (ADR-740): its storefront, checkout, Admin API and
-- renewals stop, and its data stays 90 days, during which the owner may reopen it to export it or
-- to go on; after that its data is deleted (Hatti's terms, ADR-736). `closed_at` is when it closed,
-- null for a shop open or suspended.

ALTER TABLE control.shops ADD COLUMN closed_at timestamptz;
ALTER TABLE control.shops ADD CONSTRAINT shops_closed_at
  CHECK ((status = 'closed') = (closed_at IS NOT NULL));

-- Identity closes and reopens shops between open and closed alone, never one Hatti took down.
GRANT UPDATE (status, closed_at, updated_at) ON control.shops TO hatti_identity_role;
CREATE POLICY identity_close ON control.shops
  FOR UPDATE TO hatti_identity_role
  USING (status IN ('active', 'closed')) WITH CHECK (status IN ('active', 'closed'));
-- And whatever else identity changes, as a development store going to its client (0235), it
-- never leaves a shop suspended: permissive policies' checks are any one of them, this one always.
CREATE POLICY identity_status ON control.shops
  AS RESTRICTIVE FOR UPDATE TO hatti_identity_role
  USING (true) WITH CHECK (status IN ('active', 'closed'));

CREATE POLICY identity_shop_closed ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type IN ('shop.closed', 'shop.reopened') AND aggregate_type = 'shop'
              AND aggregate_id = shop_id);

-- Closed shops by when they closed, for the sweep that deletes them after 90 days.
CREATE INDEX shops_closed ON control.shops (closed_at) WHERE status = 'closed';
