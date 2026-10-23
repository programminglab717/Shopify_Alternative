-- 0327 · Labels on the inbox's conversations
-- A shop's staff label conversations with what the customer writes about (MSG-06, ADR-764):
-- "delivery", "size", "refund". A conversation has up to 10, of up to 40 characters each, and
-- the inbox shows those with one label alone.

ALTER TABLE messaging.conversations
  ADD COLUMN labels text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(labels) <= 10);

-- The conversations with a label.
CREATE INDEX conversations_labels_idx ON messaging.conversations USING gin (labels);
