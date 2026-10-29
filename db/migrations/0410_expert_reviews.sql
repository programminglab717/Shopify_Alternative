-- 0410 · Reviews of experts
-- A shop that gave an expert access to it (ADR-488), having hired them, rates them out of five
-- and may say how the work went (PRT-03): one review a shop, kept as its owner or a manager last
-- wrote it. Shops finding experts see their ratings and reviews; the expert sees theirs. See
-- ADR-917 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.expert_reviews (
  partner_id uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  shop_id    uuid        NOT NULL REFERENCES control.shops (id),
  -- Who last wrote it, of the shop's owners and managers.
  user_id    uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  rating     smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       text        NOT NULL DEFAULT '' CHECK (char_length(body) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, shop_id)
);

CREATE INDEX expert_reviews_partner_idx ON identity.expert_reviews (partner_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.expert_reviews TO hatti_identity_role;
