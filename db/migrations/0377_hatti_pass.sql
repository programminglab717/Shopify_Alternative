-- 0377 · Hatti Pass: a shopper's details for any Hatti shop's checkout (CUS-08, ADR-867)
-- A shopper who proved their number at a shop's checkout may save their name, email and address
-- to Hatti Pass, by a box they tick; at any Hatti shop's checkout, once they prove the number
-- again, "Ordered here before?" fills them in where that shop has no order of theirs. It is
-- Hatti's, kept with the shopper's consent, not any shop's: a shop sees it only as the form its
-- shopper filled in from it. The shopper forgets it from any checkout, once they prove the number.

CREATE TABLE platform.hatti_passes (
  -- The shopper's mobile number in E.164.
  phone        text        PRIMARY KEY CHECK (phone ~ '^\+923\d{9}$'),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  email        text        CHECK (char_length(email) <= 255),
  -- Where to deliver, as checkout's form takes it: name aside, address1, address2, landmark, city,
  -- provinceCode and location.
  address      jsonb       NOT NULL,
  -- The shop whose checkout it was saved at, last.
  saved_at_shop uuid       NOT NULL,
  consented_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz
);

-- Checkout reads and writes it in each shop's transactions, for the number the shopper proved.
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.hatti_passes TO hatti_app_role, hatti_system_role;
