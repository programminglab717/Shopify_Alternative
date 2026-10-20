-- 0291 · Orders staff take, sent to Meta
-- Where the shop says so (staff_orders), an order its staff took from a chat, at the shop's counter
-- or by phone is sent to Meta's conversions API too, as a chat, physical_store or other event.
-- See ADR-655 in docs/architecture/13-decision-log.md.

ALTER TABLE marketing.meta_settings ADD COLUMN staff_orders boolean NOT NULL DEFAULT false;
