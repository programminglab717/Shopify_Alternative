-- 0321 · The inbox's saved replies
-- What a shop's staff write to customers again and again, kept to answer with in a tap (MSG-06):
-- a title to find each by, and the words, in English, Urdu or both. See ADR-758 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE messaging.saved_replies (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  title      text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  -- As long as a WhatsApp reply may be (ADR-546).
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('messaging.saved_replies');

-- A title names one reply of a shop's, whatever its case.
CREATE UNIQUE INDEX saved_replies_title ON messaging.saved_replies (shop_id, lower(title));
