-- 0070 · Staff invitations
-- Owners and managers invite people to their shop with a role, by a link they send themselves,
-- which the person accepts once signed in; they change staff's roles and remove staff. Nobody is
-- invited as the owner, and only the owner manages managers. See ADR-101 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE identity.invitations (
  id          uuid        PRIMARY KEY,
  shop_id     uuid        NOT NULL REFERENCES control.shops (id),
  role        text        NOT NULL
                          CHECK (role IN ('manager', 'confirmation_agent', 'packer', 'marketer',
                                          'accountant')),
  -- Whom it is for, as the inviter noted it: "Bilal, for packing".
  note        text        CHECK (char_length(note) BETWEEN 1 AND 100),
  -- The link's secret, as SHA-256: the link itself is shown once.
  token_hash  bytea       NOT NULL UNIQUE,
  invited_by  uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  -- Who accepted it is kept until their account goes.
  CHECK (accepted_by IS NULL OR accepted_at IS NOT NULL)
);

CREATE INDEX invitations_shop_idx ON identity.invitations (shop_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.invitations TO hatti_identity_role;
