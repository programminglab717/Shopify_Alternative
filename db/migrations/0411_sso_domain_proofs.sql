-- 0411 · A shop's single sign-on domains proved through DNS (ADM-09)
-- An owner names the email domains its staff sign in with; until now any shop could name any
-- domain, and a sign-in by email went to the shop that saved it last. Now each shop has a token,
-- for a TXT record at _hatti-sso.<domain>: once DNS shows it, the domain is proved the shop's.
-- A domain is proved by one shop alone, which then takes every sign-in by email of it, and no
-- other shop names it. See ADR-919 in docs/architecture/13-decision-log.md.

ALTER TABLE identity.shop_sso
  ADD COLUMN proof_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');

CREATE TABLE identity.sso_domains (
  -- One shop's alone.
  domain     text        PRIMARY KEY CHECK (domain = lower(domain) AND char_length(domain) <= 253),
  shop_id    uuid        NOT NULL REFERENCES identity.shop_sso (shop_id) ON DELETE CASCADE,
  proved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sso_domains_shop ON identity.sso_domains (shop_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.sso_domains TO hatti_identity_role;
