-- 0209 · Gift cards sold as products (CAT-12)
-- A product the shop sells as a gift card, as Shopify's `isGiftCard`: each unit of it in an order
-- paid in full issues a card worth what it sold for, sent to the buyer's number. The cards keep
-- which order line issued them, so that each is issued once.
-- See ADR-451 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products ADD COLUMN gift_card boolean NOT NULL DEFAULT false;

ALTER TABLE customers.gift_cards
  ADD COLUMN order_id      uuid,
  ADD COLUMN line_item_id  uuid,
  ADD COLUMN line_unit     smallint CHECK (line_unit >= 1),
  ADD CONSTRAINT gift_cards_line_check
    CHECK ((line_item_id IS NULL) = (line_unit IS NULL) AND (line_item_id IS NULL) = (order_id IS NULL));

-- Each unit of an order line issues one card, once.
CREATE UNIQUE INDEX gift_cards_line_unit_key
  ON customers.gift_cards (shop_id, line_item_id, line_unit)
  WHERE line_item_id IS NOT NULL;
