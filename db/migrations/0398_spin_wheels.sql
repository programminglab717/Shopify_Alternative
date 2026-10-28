-- 0398 · Spin to win
-- A shop's wheel of offers on its sign-up pop-up (OS-08): a shopper gives their number, is signed
-- up for the shop's news and offers, and the wheel stops at a slice chosen by its weight, whose
-- offer becomes a code of their own, for one order. Once a number. See ADR-900 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE pricing.spin_wheels (
  shop_id           uuid        PRIMARY KEY,
  enabled           boolean     NOT NULL DEFAULT false,
  -- 2 to 8 slices, in the wheel's order: [{"label", "kind": "percentage" | "amount" |
  -- "free_shipping" | "none", "percentage", "amount", "weight"}], amounts in major units.
  slices            jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(slices) = 'array'),
  -- How long a shopper's code works.
  code_days         integer     NOT NULL DEFAULT 7 CHECK (code_days BETWEEN 1 AND 90),
  -- What an order's items must come to for a code to work, in minor units; null for nothing.
  minimum_subtotal  bigint      CHECK (minimum_subtotal IS NULL OR minimum_subtotal > 0),
  version           integer     NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('pricing.spin_wheels');

-- A number's spin: the slice it stopped at, and the code it gave, kept so that spinning again
-- answers the same.
CREATE TABLE pricing.spins (
  shop_id     uuid        NOT NULL,
  -- E.164.
  phone       text        NOT NULL,
  slice       integer     NOT NULL CHECK (slice BETWEEN 0 AND 7),
  label       text        NOT NULL,
  code_id     uuid,
  code        text,
  ends_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, phone)
);

SELECT platform.enable_tenant_isolation('pricing.spins');
