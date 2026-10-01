-- 0056 · Trust badges on the checkout
-- A shop chooses up to four badges from the platform's set for its checkout's page (CHK-14), which
-- shows them under its button in English and Urdu: cash on delivery, opening the parcel before
-- paying, an exchange or returns within so many days, original products, and help on WhatsApp.
-- A row per shop once it chooses any. See ADR-086 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.trust_badges (
  shop_id    uuid        PRIMARY KEY,
  -- In the shop's order: [{"kind": "exchange", "days": 7}, {"kind": "original"}]; days for an
  -- exchange or returns alone.
  badges     jsonb       NOT NULL DEFAULT '[]'
                         CHECK (jsonb_typeof(badges) = 'array' AND jsonb_array_length(badges) <= 4),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('checkout.trust_badges');
