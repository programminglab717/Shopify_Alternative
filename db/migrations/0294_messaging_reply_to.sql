-- 0294 · Replies to a shop's emails reach the shop
-- Where a shop gives an address for replies, its customers' emails about their orders carry it as
-- their Reply-To, and say a reply reaches the shop. See ADR-659 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE messaging.settings
  ADD COLUMN reply_to_email text
    CHECK (char_length(reply_to_email) <= 254 AND reply_to_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$');
