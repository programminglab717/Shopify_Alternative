-- 0255 · Shops told of outages on WhatsApp
-- When Hatti posts an outage, each shop hears it on WhatsApp at its alerts number, from Hatti's
-- number and at Hatti's cost (BIL-06): the update that opens it and the one that ends it, each
-- once. Those already posted are not sent now. See ADR-544 in docs/architecture/13-decision-log.md.

ALTER TABLE trust.incident_updates ADD COLUMN shops_told_at timestamptz;
UPDATE trust.incident_updates SET shops_told_at = posted_at;
CREATE INDEX incident_updates_to_tell_shops ON trust.incident_updates (posted_at)
  WHERE shops_told_at IS NULL;
