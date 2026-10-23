-- 0320 · Internet addresses kept no longer than they are needed (ADR-748)
-- Comments on articles lose the address and browser they were posted from 90 days after; the
-- log of staff's sign-ins and account changes is kept two years. These indexes find what is past
-- its time without reading the whole table.

CREATE INDEX comments_addressed_idx ON online_store.comments (created_at)
  WHERE ip IS NOT NULL OR user_agent IS NOT NULL;
CREATE INDEX auth_events_occurred_idx ON identity.auth_events (occurred_at);
