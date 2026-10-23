-- 0328 · Delivery time slots
-- A shop that delivers itself, such as a bakery, a grocer or a florist, offers times of the day
-- to deliver in, in Pakistan's time: "10:00 to 13:00", "16:00 to 19:00". Checkout offers each on
-- the days ahead the shop says, from the hours ahead it needs to prepare (CHK-15). See ADR-768
-- in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings
  ADD COLUMN slots jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) <= 8),
  ADD COLUMN slot_days smallint NOT NULL DEFAULT 7 CHECK (slot_days BETWEEN 1 AND 14),
  ADD COLUMN slot_lead_hours smallint NOT NULL DEFAULT 2 CHECK (slot_lead_hours BETWEEN 0 AND 72);
