-- 0414 · Expansion stores priced at the day's rate (CH-11)
-- An owner may have an expansion store follow the day's rate between the two shops' currencies,
-- as the currency feed gives it (ADR-865), rather than a rate fixed by hand: the worker keeps the
-- link's rate as the feed changes, and a store copied to as products change is copied again at
-- the new rate. A rate given by hand stops following. See ADR-929 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN follow_rate     boolean     NOT NULL DEFAULT false,
  -- When the worker last changed its rate, following the feed: a copy after it is due.
  ADD COLUMN rate_changed_at timestamptz;
