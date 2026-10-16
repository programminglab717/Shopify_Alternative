-- 0208 · Gift cards at checkout (PAY-13)
-- The gift card a shopper applied on the checkout's page, which pays what it can of the order as
-- it is placed, and how many codes the page was given that were no card's, which it takes only
-- so many of.
-- See ADR-449 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.checkouts
  ADD COLUMN gift_card_id       uuid,
  ADD COLUMN gift_card_attempts smallint NOT NULL DEFAULT 0 CHECK (gift_card_attempts >= 0);
