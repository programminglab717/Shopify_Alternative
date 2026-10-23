-- 0322 · Conversations given to staff
-- A conversation may be given to a member of staff to answer (MSG-06, ADR-759): who, by their
-- account's ID, and since when. The account is the identity module's, so nothing here refers to
-- it: the core checks that they work in the shop, as for orders (0080).

ALTER TABLE messaging.conversations
  ADD COLUMN assignee_id uuid,
  ADD COLUMN assigned_at timestamptz,
  ADD CONSTRAINT conversations_assignee_check CHECK ((assignee_id IS NULL) = (assigned_at IS NULL));

-- Each member of staff's conversations, the latest written first.
CREATE INDEX conversations_assignee_idx
  ON messaging.conversations (shop_id, assignee_id, last_message_at DESC, id DESC)
  WHERE assignee_id IS NOT NULL;
