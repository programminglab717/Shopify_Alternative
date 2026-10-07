-- 0154 · Checkout's codes limited by internet address
-- The one-time codes checkout sends to prove shoppers' numbers (CHK-09) are capped for each
-- checkout and each number; one internet address could still start checkouts for many numbers and
-- spend the shop's message credits on codes to each. A code now keeps the address the shopper asked
-- for it from, and checkout sends at most so many an hour from one address (CHK-18). The address
-- goes with its code, and so with its checkout, a day after it began. See ADR-249 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.number_codes ADD COLUMN ip inet;

-- How many codes an address asked for lately, across the shop's checkouts.
CREATE INDEX number_codes_ip ON checkout.number_codes (shop_id, ip, created_at DESC)
  WHERE ip IS NOT NULL;
