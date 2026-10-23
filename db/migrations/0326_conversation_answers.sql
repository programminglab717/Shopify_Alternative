-- 0326 · How long customers waited for an answer
-- Each answer to a customer who waited on WhatsApp, with since when they waited and who answered
-- (MSG-06, ADR-763): what the inbox's reply times are reported from. It keeps neither the
-- customer's number nor the words. See ADR-763 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.conversation_answers (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  conversation_id uuid        NOT NULL,
  waited_from     timestamptz NOT NULL,
  answered_at     timestamptz NOT NULL CHECK (answered_at >= waited_from),
  actor_kind      text        NOT NULL CHECK (actor_kind IN ('staff', 'app')),
  actor_id        uuid        NOT NULL,
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('messaging.conversation_answers');

-- A period's answers, as the report reads them.
CREATE INDEX conversation_answers_answered_idx
  ON messaging.conversation_answers (shop_id, answered_at);
