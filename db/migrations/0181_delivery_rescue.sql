-- 0181 · Failed-delivery rescue
-- When a courier tries a parcel and cannot deliver it, its customer is asked on WhatsApp whether
-- to try again or to be called (COD-08); their answer is kept on the parcel, for the shop to pass
-- to its courier from the deliveries to rescue. See ADR-388 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.fulfillments
  ADD COLUMN rescue_answer      text CHECK (rescue_answer IN ('retry', 'call')),
  ADD COLUMN rescue_answered_at timestamptz,
  ADD CONSTRAINT fulfillments_rescue_check
    CHECK ((rescue_answer IS NULL) = (rescue_answered_at IS NULL));
