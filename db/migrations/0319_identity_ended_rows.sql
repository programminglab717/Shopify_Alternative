-- 0319 · What has ended in identity, kept for a while and no longer (ADR-747)
-- Sessions unused for 90 days, which have all ended, and second steps' challenges past their
-- end by a month are deleted as new ones are made; these indexes find them without reading the
-- whole table.

CREATE INDEX sessions_last_used_idx ON identity.sessions (last_used_at);
CREATE INDEX mfa_challenges_expires_idx ON identity.mfa_challenges (expires_at);
