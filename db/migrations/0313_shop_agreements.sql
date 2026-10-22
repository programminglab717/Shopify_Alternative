-- 0313 · What a shop's owner agreed to
-- Opening a shop, or a partner's development store, records its owner's agreement to Hatti's terms
-- of service, acceptable use policy and data processing agreement: each document by the version
-- the owner was shown, who agreed, and from where (ADR-737). The versions are those of
-- @hatti/legal (ADR-736); an agreement is never changed, and a new version asks for a new one.

CREATE TABLE identity.shop_agreements (
  id          uuid        PRIMARY KEY,
  shop_id     uuid        NOT NULL REFERENCES control.shops (id),
  -- Who agreed; kept as evidence after their account is gone, as the audit log keeps actors.
  user_id     uuid        NOT NULL,
  -- {"terms": "2026-10-22", "acceptable-use": "2026-10-22", "data-processing": "2026-10-22"}
  documents   jsonb       NOT NULL CHECK (jsonb_typeof(documents) = 'object'),
  ip          inet,
  user_agent  text,
  agreed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shop_agreements_shop_idx ON identity.shop_agreements (shop_id, agreed_at);

GRANT SELECT, INSERT ON identity.shop_agreements TO hatti_identity_role;
