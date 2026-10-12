-- 0179 · Courier rules for the cheapest account
-- A courier rule may book what it matches with the cheapest of the shop's accounts by their rate
-- cards (SHP-06, SHP-07) rather than with one account: a rule without an account is that rule,
-- and may be for every order, naming neither cities nor cash. Where no live account has a card,
-- the rule is passed over. See ADR-385 in docs/architecture/13-decision-log.md.

ALTER TABLE logistics.courier_rules ALTER COLUMN account_id DROP NOT NULL;

COMMENT ON COLUMN logistics.courier_rules.account_id IS
  'The account that books what the rule matches; null for the cheapest by rate cards (ADR-385).';

-- A rule for one account names cities or cash, or it would stand in for the default account.
ALTER TABLE logistics.courier_rules DROP CONSTRAINT courier_rules_check;
ALTER TABLE logistics.courier_rules ADD CONSTRAINT courier_rules_matches_check
  CHECK (account_id IS NULL OR cardinality(cities) > 0 OR cod_at_least IS NOT NULL
         OR cod_below IS NOT NULL);
