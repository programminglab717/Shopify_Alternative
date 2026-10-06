-- 0138 · The order a shop's gateways are offered in
-- A shop puts its payment gateway accounts in the order its customers are offered them, on an
-- order's page and checkout's thank-you page (PAY-05), in place of the order it connected them in
-- (ADR-219); an account connected later goes last. Those connected before keep that order. See
-- ADR-221 in docs/architecture/13-decision-log.md.

ALTER TABLE payments.gateway_accounts ADD COLUMN position integer NOT NULL DEFAULT 0;

UPDATE payments.gateway_accounts a
   SET position = ranked.position
  FROM (SELECT shop_id, id,
               row_number() OVER (PARTITION BY shop_id ORDER BY created_at, id) AS position
          FROM payments.gateway_accounts) ranked
 WHERE a.shop_id = ranked.shop_id AND a.id = ranked.id;
