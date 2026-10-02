-- 0109 · Invitations by email
-- Hatti emails an invitation to work in a shop to the address its inviter gives, beside the link
-- the inviter shares themselves; whoever holds the link still accepts it (ADR-101). See ADR-167 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE identity.invitations
  -- Where Hatti emailed its link, lowercased; null for one whose link the inviter shares alone.
  ADD COLUMN email text CHECK (email IS NULL OR (email = lower(email) AND length(email) <= 254));

-- A shop's invitations by email lately, to keep it to a few a day.
CREATE INDEX invitations_emailed_idx ON identity.invitations (shop_id, created_at)
  WHERE email IS NOT NULL;
