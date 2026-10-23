-- 0334 · Carts priced for the signed-in shopper who used them
-- A cart keeps the account session of the shopper last signed in while they used it, so the
-- cart and its checkout price its lines from that customer's price lists while the session
-- lasts (CUS-06). See ADR-780 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.carts ADD COLUMN account_session_id uuid;
