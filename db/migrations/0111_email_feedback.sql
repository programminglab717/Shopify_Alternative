-- 0111 · Bounces and complaints
-- Amazon SES tells Hatti through an SNS topic of each of its emails that bounced for good, or that
-- its recipient marked as spam (ONB-01). Hatti sends no more email to such an address, as SES asks
-- of the senders it lets out of its sandbox. See ADR-170 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.email_suppressions (
  email       text        PRIMARY KEY
                          CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'
                                 AND length(email) <= 254),
  -- bounce: the address's server said it takes no mail, for good; complaint: its recipient
  -- marked an email of Hatti's as spam.
  reason      text        NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  -- What the server said, or the kind of complaint, for support: "smtp; 550 5.1.1 user unknown".
  detail      text        CHECK (length(detail) <= 1000),
  -- SES's ID for the feedback last heard of the address.
  feedback_id text        NOT NULL CHECK (length(feedback_id) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.email_suppressions TO hatti_identity_role;
