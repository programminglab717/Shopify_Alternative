-- The store locator (OS-18, ADR-828): a location the shop lists on its online store, for customers
-- to find and visit, with its opening hours as the merchant writes them, "Mon–Sat 10am–9pm".
ALTER TABLE inventory.locations
  ADD COLUMN storefront_listed boolean NOT NULL DEFAULT false,
  ADD COLUMN opening_hours     text    CHECK (char_length(opening_hours) BETWEEN 1 AND 300);
