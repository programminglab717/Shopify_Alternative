-- 0165 · Shops' domains checked again
-- A verified domain is asked about again in the background (ONB-07): by the worker, every six
-- hours, through the system login across shops. One that DNS points elsewhere is noted from when,
-- and its shop told; three days on, it is disconnected, verified no more, nor primary. See ADR-262
-- in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.domains
  -- When DNS was last asked about it, by the worker or as the shop asked; null until it has been
  -- since this.
  ADD COLUMN checked_at      timestamptz,
  -- Since when the worker has found DNS pointing it elsewhere; null while it points at the
  -- platform.
  ADD COLUMN unpointed_since timestamptz;

-- The verified domains to ask about again, across shops, those asked longest ago first.
CREATE INDEX domains_checked_idx ON online_store.domains (checked_at NULLS FIRST)
  WHERE verified_at IS NOT NULL;
