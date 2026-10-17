-- 0235 · Partners
-- Agencies and freelancers who build stores for others join Hatti's partner programme from their
-- own accounts (PRT-01): a business name, and a referral code of their own for the stores they
-- bring (PRT-02). A partner opens development stores, which stay closed to shoppers while they
-- are built, and count against none of the five shops an account may own; handing one to its
-- client, as an owner hands any shop over (ADR-104), opens it. Each store a partner made, or
-- brought, is kept with when it went to whom. See ADR-504 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.partners (
  user_id       uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  business_name text        NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 120),
  website       text        CHECK (char_length(website) BETWEEN 1 AND 300
                                   AND website ~ '^https://'),
  -- Lowercase letters and digits, given once, for links that bring a store to them.
  referral_code text        NOT NULL UNIQUE CHECK (referral_code ~ '^[a-z0-9]{8}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Closed to shoppers while a partner builds it, until it is handed to its client.
ALTER TABLE control.shops ADD COLUMN development boolean NOT NULL DEFAULT false;

CREATE TABLE identity.partner_stores (
  -- A store has one partner at most.
  shop_id        uuid        PRIMARY KEY REFERENCES control.shops (id),
  partner_id     uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  -- Development: the partner opened it to build. Referred: its owner came by the partner's code.
  kind           text        NOT NULL CHECK (kind IN ('development', 'referred')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  transferred_at timestamptz,
  transferred_to uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  CHECK (transferred_at IS NULL OR kind = 'development'),
  CHECK (transferred_to IS NULL OR transferred_at IS NOT NULL)
);

CREATE INDEX partner_stores_partner_idx ON identity.partner_stores (partner_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.partners, identity.partner_stores
  TO hatti_identity_role;
GRANT INSERT (development), UPDATE (development) ON control.shops TO hatti_identity_role;

-- The identity login opens a development store as the partner hands it over, and says so.
CREATE POLICY identity_transfer_development ON control.shops
  FOR UPDATE TO hatti_identity_role USING (development) WITH CHECK (NOT development);
CREATE POLICY identity_development_store_transferred ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type = 'shop.development_store_transferred' AND aggregate_type = 'shop'
              AND aggregate_id = shop_id);
