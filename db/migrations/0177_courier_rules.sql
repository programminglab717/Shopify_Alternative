-- 0177 · Courier rules
-- Which of the shop's courier accounts books an order when staff do not name one (SHP-06): the
-- first of the shop's rules, in its order, that the order's city and the cash its courier is to
-- collect match; else the shop's default account. See ADR-382 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE logistics.courier_rules (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Where it comes among the shop's rules, the first that matches booking the order.
  position     integer     NOT NULL CHECK (position >= 0),
  account_id   uuid        NOT NULL,
  -- Cities as Pakistan's list names them; none for anywhere.
  cities       text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(cities) <= 100),
  -- The cash to collect, in minor units: at least, and below; null for no bound.
  cod_at_least bigint      CHECK (cod_at_least >= 0),
  cod_below    bigint      CHECK (cod_below > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, position),
  FOREIGN KEY (shop_id, account_id) REFERENCES logistics.courier_accounts (shop_id, id),
  CHECK (cardinality(cities) > 0 OR cod_at_least IS NOT NULL OR cod_below IS NOT NULL),
  CHECK (cod_at_least IS NULL OR cod_below IS NULL OR cod_at_least < cod_below)
);

SELECT platform.enable_tenant_isolation('logistics.courier_rules');
