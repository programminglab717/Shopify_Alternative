-- 0112 · Changing an account's email
-- An account's owner changes its email, or gives one to an account opened with a phone, from a
-- session proved lately (ONB-01): a link to the new address proves it before it counts, and the
-- old address is told. The link is an email token of a purpose of its own. See ADR-172 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE identity.email_tokens
  DROP CONSTRAINT email_tokens_purpose_check,
  ADD CONSTRAINT email_tokens_purpose_check
    CHECK (purpose IN ('verify_email', 'reset_password', 'change_email')),
  -- The language its email was written in, which what follows from it is told in.
  ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ur'));
