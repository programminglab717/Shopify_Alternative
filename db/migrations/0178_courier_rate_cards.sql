-- 0178 · Couriers' rate cards, and what each parcel is likely to cost
-- What a courier account charges (SHP-07): by weight, in its first half kilo and each half kilo
-- after, within the city the shop ships from and to other cities; a share of the cash it
-- collects; and a share of the charge again to bring a parcel back. Each booking keeps what its
-- parcel is likely to cost by the card when the courier booked it, and so does the parcel, so that
-- profit counts it until the courier's statement says what it charged. See ADR-383 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE logistics.rate_cards (
  shop_id       uuid        NOT NULL,
  account_id    uuid        NOT NULL,
  -- The city parcels go from, as Pakistan's list names it.
  origin_city   text        NOT NULL CHECK (char_length(origin_city) BETWEEN 1 AND 100),
  -- Minor units: the first half kilo, and each half kilo after, within the city and beyond it.
  local_first   bigint      NOT NULL CHECK (local_first >= 0),
  local_each    bigint      NOT NULL CHECK (local_each >= 0),
  other_first   bigint      NOT NULL CHECK (other_first >= 0),
  other_each    bigint      NOT NULL CHECK (other_each >= 0),
  -- Hundredths of a percent: of the cash collected, and of the charge, for a parcel back.
  cod_fee_bp    integer     NOT NULL DEFAULT 0 CHECK (cod_fee_bp BETWEEN 0 AND 2000),
  return_bp     integer     NOT NULL DEFAULT 0 CHECK (return_bp BETWEEN 0 AND 20000),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, account_id),
  FOREIGN KEY (shop_id, account_id) REFERENCES logistics.courier_accounts (shop_id, id)
);

SELECT platform.enable_tenant_isolation('logistics.rate_cards');

-- What the parcel is likely to cost by its account's card, kept when the courier booked it:
-- out, the share of the cash collected, and back; null where the account had no card.
ALTER TABLE logistics.bookings
  ADD COLUMN estimate_out     bigint CHECK (estimate_out >= 0),
  ADD COLUMN estimate_cod_fee bigint CHECK (estimate_cod_fee >= 0),
  ADD COLUMN estimate_back    bigint CHECK (estimate_back >= 0),
  ADD CHECK ((estimate_out IS NULL) = (estimate_cod_fee IS NULL)
             AND (estimate_out IS NULL) = (estimate_back IS NULL));

-- The same on the parcel, for the sales report's profit until a statement charges it.
ALTER TABLE orders.fulfillments
  ADD COLUMN charge_estimate_out     bigint CHECK (charge_estimate_out >= 0),
  ADD COLUMN charge_estimate_cod_fee bigint CHECK (charge_estimate_cod_fee >= 0),
  ADD COLUMN charge_estimate_back    bigint CHECK (charge_estimate_back >= 0),
  ADD CHECK ((charge_estimate_out IS NULL) = (charge_estimate_cod_fee IS NULL)
             AND (charge_estimate_out IS NULL) = (charge_estimate_back IS NULL));
