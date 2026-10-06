-- 0142 · Expired carts and checkouts swept
-- The worker deletes carts, checkouts and browsers' proofs of a number once they are past their
-- time, across shops, every sweep, rather than a few of a shop's each time it gets a new one:
-- the longest expired are found by when they expired, whichever shop's they are, and each shop's
-- are deleted in its own transaction. Nothing reads one once it has expired, and a proof keeps a
-- customer's number no longer than it spares them a code. See ADR-230 in
-- docs/architecture/13-decision-log.md.

DROP INDEX checkout.carts_expires_at_idx;
CREATE INDEX carts_expires_at_idx ON checkout.carts (expires_at);

DROP INDEX checkout.checkouts_expires_at_idx;
CREATE INDEX checkouts_expires_at_idx ON checkout.checkouts (expires_at);

DROP INDEX checkout.number_proofs_expiry;
CREATE INDEX number_proofs_expiry ON checkout.number_proofs (expires_at);
