-- 0063 · Claims on couriers for the parcels they lost
-- A shop claims a lost parcel's worth from its courier, and the claim is the parcel's, followed
-- until the courier pays it, in a statement or otherwise, or refuses it, or the shop withdraws it
-- (COD-09). A statement's cash for a lost parcel pays its claim, filing one if the shop had not:
-- statements imported before pay theirs here, as an import now would have. See ADR-093 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.fulfillments
  ADD COLUMN claim_status text CHECK (claim_status IN ('open', 'paid', 'refused', 'withdrawn')),
  -- Minor units: what the shop claims, and what the courier paid on it.
  ADD COLUMN claim_amount bigint CHECK (claim_amount > 0),
  ADD COLUMN claim_paid bigint CHECK (claim_paid > 0),
  -- The shop's own words: the courier's claim number, or why it was refused.
  ADD COLUMN claim_note text CHECK (length(claim_note) BETWEEN 1 AND 500),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claim_settled_at timestamptz,
  ADD CONSTRAINT fulfillments_claim_check CHECK (
    (claim_status IS NULL) = (claim_amount IS NULL)
    AND (claim_status IS NULL) = (claimed_at IS NULL)
    AND coalesce(claim_status = 'paid', false) = (claim_paid IS NOT NULL)
    AND coalesce(claim_status <> 'open', false) = (claim_settled_at IS NOT NULL));

-- Lost parcels are listed the longest lost first, with their claims, and the home counts those
-- to claim: an index of those alone, as they are few beside the parcels delivered.
CREATE INDEX fulfillments_lost_idx
  ON orders.fulfillments (shop_id, lost_at, id)
  WHERE status = 'lost';

ALTER TABLE logistics.cod_remittances
  -- What of the cash paid claims for lost parcels, as `received` is what was received on orders.
  ADD COLUMN compensated bigint NOT NULL DEFAULT 0 CHECK (compensated >= 0);

ALTER TABLE logistics.cod_remittance_lines DROP CONSTRAINT cod_remittance_lines_outcome_check;
ALTER TABLE logistics.cod_remittance_lines
  ADD CONSTRAINT cod_remittance_lines_outcome_check CHECK (outcome IN (
    'received', 'short', 'over', 'unmatched', 'repeated', 'not_owed', 'charged',
    'compensated'));

-- Statements imported before: a lost parcel's cash, which nothing received, paid its claim.
-- A parcel's cash is collected once, so each has one such line at most.
WITH paid AS (
  UPDATE logistics.cod_remittance_lines l
     SET outcome = 'compensated'
    FROM orders.fulfillments f
   WHERE f.shop_id = l.shop_id AND f.id = l.fulfillment_id AND f.status = 'lost'
     AND l.outcome = 'not_owed' AND l.collected > 0
  RETURNING l.shop_id, l.fulfillment_id, l.remittance_id, l.collected
)
UPDATE orders.fulfillments f
   SET claim_status = 'paid',
       -- Its worth, the items in it at their prices on the order, or what was paid if more.
       claim_amount = greatest((
         SELECT sum(fl.quantity * ol.unit_price)
           FROM orders.fulfillment_lines fl
           JOIN orders.lines ol ON ol.shop_id = fl.shop_id AND ol.id = fl.line_id
          WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id), paid.collected),
       claim_paid = paid.collected,
       claimed_at = r.created_at,
       claim_settled_at = r.created_at
  FROM paid
  JOIN logistics.cod_remittances r
    ON r.shop_id = paid.shop_id AND r.id = paid.remittance_id
 WHERE f.shop_id = paid.shop_id AND f.id = paid.fulfillment_id;

UPDATE logistics.cod_remittances r
   SET compensated = l.compensated
  FROM (SELECT shop_id, remittance_id, sum(collected) AS compensated
          FROM logistics.cod_remittance_lines
         WHERE outcome = 'compensated'
         GROUP BY shop_id, remittance_id) l
 WHERE r.shop_id = l.shop_id AND r.id = l.remittance_id;
