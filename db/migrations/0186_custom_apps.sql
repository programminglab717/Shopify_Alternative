-- 0186 · Custom apps (DEV-04)
-- An access token is a custom app: the shop's owner or a manager makes one with a name and the
-- scopes it may use, none their own role lacks, and is shown its token once. Each app made from
-- now on has a secret its webhooks are signed with (DEV-03), kept sealed for that app alone and
-- shown once too; the token and the secret can each be replaced, and the app removed, which
-- revokes its token. See ADR-395 in docs/architecture/13-decision-log.md.

ALTER TABLE apps.access_tokens
  -- The secret, sealed with the platform's SecretBox for this shop and app. Null for tokens made
  -- before apps had one, until a new one is made.
  ADD COLUMN webhook_secret text,
  ADD COLUMN secret_hint    text,
  -- The member of staff who made it; null for those made otherwise.
  ADD COLUMN created_by     uuid,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT access_tokens_secret_check
    CHECK ((webhook_secret IS NULL) = (secret_hint IS NULL));

-- The shop's apps, the latest first.
CREATE INDEX access_tokens_shop_idx ON apps.access_tokens (shop_id, created_at DESC)
  WHERE revoked_at IS NULL;
