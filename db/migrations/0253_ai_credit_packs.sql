-- 0253 · AI credits bought
-- A shop that has spent its plan's AI credits for the month (ADR-533) buys more, a hundred at a
-- time, paid from its message credit (ADR-155) as an entry of their own. Bought credits last until
-- spent; the month's own are spent first, and each use says which it spent.
-- See ADR-539 in docs/architecture/13-decision-log.md.

ALTER TABLE billing.wallet_entries
  DROP CONSTRAINT wallet_entries_kind_check,
  ADD CONSTRAINT wallet_entries_kind_check
    CHECK (kind IN ('top_up', 'grant', 'message', 'message_refund', 'ai_credits')),
  DROP CONSTRAINT wallet_entries_check,
  ADD CONSTRAINT wallet_entries_check
    CHECK (CASE WHEN kind IN ('message', 'ai_credits') THEN amount < 0 ELSE amount > 0 END);

CREATE TABLE billing.ai_credit_packs (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  credits    integer     NOT NULL CHECK (credits BETWEEN 1 AND 100000),
  -- Paisa: what the shop's message credit paid for them.
  price      bigint      NOT NULL CHECK (price > 0),
  bought_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('billing.ai_credit_packs');
REVOKE UPDATE, DELETE ON billing.ai_credit_packs FROM hatti_app_role;

-- Whether a use spent a bought credit, the month's own being spent.
ALTER TABLE billing.ai_credit_uses ADD COLUMN from_pack boolean NOT NULL DEFAULT false;
