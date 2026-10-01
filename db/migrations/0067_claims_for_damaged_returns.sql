-- 0067 · Claims for parcels that came back damaged
-- A parcel that came back with items written off as damaged is claimed from its courier for
-- those items' worth, as a lost parcel is for its own (COD-09). Claims are listed the oldest first,
-- and the home counts those still open: an index of the parcels with claims alone. See ADR-098
-- in docs/architecture/13-decision-log.md.

-- Only a parcel lost, or one back with items written off, is claimed: a lost parcel that turned up
-- keeps its claim, paid or withdrawn.
ALTER TABLE orders.fulfillments
  ADD CONSTRAINT fulfillments_claimed_status_check
    CHECK (claim_status IS NULL OR status IN ('lost', 'returned'));

CREATE INDEX fulfillments_claims_idx
  ON orders.fulfillments (shop_id, claimed_at, id)
  WHERE claim_status IS NOT NULL;
