-- 0370 · Partners' certification (PRT-04)
-- Hatti's course for partners, in English and Urdu: lessons on running a shop on Hatti, and ten
-- questions. A partner who answers eight rightly is certified for a year, of the course's
-- version they passed; three tries a day. Certified experts are marked so for shops (ADR-855).
-- See ADR-858 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.certification_attempts (
  id             uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  partner_id     uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  course_version text        NOT NULL CHECK (char_length(course_version) BETWEEN 1 AND 20),
  score          smallint    NOT NULL CHECK (score >= 0),
  passed         boolean     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certification_attempts_partner_idx
  ON identity.certification_attempts (partner_id, created_at DESC);

CREATE TABLE identity.partner_certificates (
  partner_id     uuid        PRIMARY KEY REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  course_version text        NOT NULL CHECK (char_length(course_version) BETWEEN 1 AND 20),
  score          smallint    NOT NULL CHECK (score >= 0),
  passed_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  CHECK (expires_at > passed_at)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.certification_attempts,
  identity.partner_certificates TO hatti_identity_role;
