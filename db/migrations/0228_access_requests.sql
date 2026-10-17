-- Collaborator access requests (ADM-07, ADR-488): an agency or a freelancer, signed in to their own
-- Hatti account, asks a shop by its handle for a role for some days; the shop's owner, or a
-- manager for the roles below them, approves it, which makes a membership that ends by itself
-- (ADR-487), or declines it. A request waits 7 days at most.

CREATE TABLE identity.access_requests (
  id          uuid        PRIMARY KEY,
  shop_id     uuid        NOT NULL REFERENCES control.shops (id),
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  role        text        NOT NULL
                          CHECK (role IN ('manager', 'confirmation_agent', 'packer', 'marketer',
                                          'accountant')),
  -- Requests are collaborators': their access always ends.
  access_days integer     NOT NULL CHECK (access_days BETWEEN 1 AND 90),
  -- Who they are and what for: "Pixel Media, running your Meta ads".
  message     text        CHECK (char_length(message) BETWEEN 1 AND 300),
  status      text        NOT NULL DEFAULT 'pending'
                          -- Expired: no one decided it in its 7 days.
                          CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  decided_at  timestamptz,
  decided_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- One request waiting from an account to a shop at a time.
CREATE UNIQUE INDEX access_requests_waiting_idx ON identity.access_requests (shop_id, user_id)
  WHERE status = 'pending';
CREATE INDEX access_requests_shop_idx ON identity.access_requests (shop_id, created_at);
CREATE INDEX access_requests_user_idx ON identity.access_requests (user_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.access_requests TO hatti_identity_role;
