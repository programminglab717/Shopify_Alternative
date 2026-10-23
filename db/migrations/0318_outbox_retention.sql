-- 0318 · Published events kept seven days (ADR-746)
-- The worker deletes outbox events published more than seven days ago, the oldest first, a batch
-- at a time; this index finds them without reading the whole outbox. Events not yet published
-- are kept however old, as the relay's own partial index finds them.

CREATE INDEX outbox_events_published_idx
  ON platform.outbox_events (published_at)
  WHERE published_at IS NOT NULL;
