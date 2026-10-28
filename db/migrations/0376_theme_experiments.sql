-- 0376 · Theme experiments: a shop's live theme against a draft of it (OS-22, ADR-866)
-- A shop shows a share of its shoppers a theme it hasn't published, each shopper keeping the
-- theme they were first shown, and counts each arm's sessions and those that added to the cart,
-- reached checkout and ordered. One runs at a time; it ends when the shop ends it, on its last
-- day, when its theme is published or deleted, or when the worker finds its theme sells clearly
-- worse than the live one.

CREATE TABLE online_store.theme_experiments (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- The draft theme shown in the second arm; the live theme is the first.
  theme_id     uuid        NOT NULL,
  -- The percent of shoppers shown it.
  share        integer     NOT NULL CHECK (share BETWEEN 1 AND 50),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz NOT NULL,
  ended_at     timestamptz,
  ended_reason text        CHECK (ended_reason IN ('staff', 'time', 'guardrail', 'theme_changed')),
  -- Each arm's counts as the worker last took them: sessions, added_to_cart, reached_checkout and
  -- converted, by arm.
  results      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  counted_at   timestamptz,
  PRIMARY KEY (shop_id, id),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
  CHECK (ends_at > started_at)
);

SELECT platform.enable_tenant_isolation('online_store.theme_experiments');

-- One running a shop.
CREATE UNIQUE INDEX theme_experiments_running ON online_store.theme_experiments (shop_id)
  WHERE ended_at IS NULL;
