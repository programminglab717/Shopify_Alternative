-- 0368 · Experts (PRT-03)
-- Hatti's partners (ADR-504) offer shops their services: setting a store up, designing it,
-- photographing products, running ads, moving from another platform, building apps, writing.
-- A partner's profile says what they do, where, in which languages, and from what price; Hatti
-- lists it after a look. A shop's owner or a manager finds experts in the admin and sends one an
-- enquiry, which the expert reads on their partner page, emailed to them too, with the shop's
-- handle to ask for access by (ADR-488). See ADR-855 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.expert_profiles (
  partner_id     uuid        PRIMARY KEY REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  headline       text        NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 120),
  about          text        NOT NULL DEFAULT '' CHECK (char_length(about) <= 2000),
  services       text[]      NOT NULL CHECK (cardinality(services) BETWEEN 1 AND 7
                               AND services <@ ARRAY['setup', 'design', 'photography', 'ads',
                                                     'migration', 'apps', 'content']),
  -- Where they work, as they name it: "Lahore", "Karachi", "Online".
  cities         text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(cities) <= 10),
  languages      text[]      NOT NULL CHECK (cardinality(languages) BETWEEN 1 AND 2
                               AND languages <@ ARRAY['en', 'ur']),
  -- Paisa: what their work starts at; nothing to say "ask".
  starting_price bigint      NOT NULL DEFAULT 0 CHECK (starting_price BETWEEN 0 AND 100000000),
  -- When Hatti looked at it and listed it; null while it waits.
  listed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expert_profiles_listed_idx ON identity.expert_profiles (listed_at)
  WHERE listed_at IS NOT NULL;

CREATE TABLE identity.expert_enquiries (
  id         uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  partner_id uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  shop_id    uuid        NOT NULL REFERENCES control.shops (id),
  -- Who sent it, from the shop's staff; the expert answers them by email.
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  service    text        NOT NULL CHECK (service IN ('setup', 'design', 'photography', 'ads',
                                                     'migration', 'apps', 'content')),
  message    text        NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expert_enquiries_partner_idx ON identity.expert_enquiries (partner_id, created_at DESC);
CREATE INDEX expert_enquiries_user_idx ON identity.expert_enquiries (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.expert_profiles, identity.expert_enquiries
  TO hatti_identity_role;
