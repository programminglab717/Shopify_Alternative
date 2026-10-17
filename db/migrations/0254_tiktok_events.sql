-- 0254 · TikTok's Events API
-- Orders reach TikTok's ads too (MKT-10): a shop connects its TikTok pixel with an access token
-- Events Manager gave it, and the worker sends each order placed through checkout to TikTok's
-- Events API as it is placed, confirmed and delivered, beside Meta's, the moment the shop chooses
-- as its purchase. See ADR-541 in docs/architecture/13-decision-log.md.

-- The shop's TikTok pixel and the access token TikTok's Events Manager gave it.
CREATE TABLE marketing.tiktok_settings (
  shop_id         uuid        PRIMARY KEY,
  -- As TikTok shows it: "C4A1B2C3D4E5F6G7H8I9".
  pixel_code      text        NOT NULL CHECK (pixel_code ~ '^[A-Z0-9]{10,40}$'),
  -- Sealed for the shop alone, and never shown again.
  access_token    text        NOT NULL,
  -- Its last four characters, to tell tokens apart by.
  token_hint      text        NOT NULL CHECK (char_length(token_hint) = 4),
  -- Events Manager's code for test events, while the shop tries them out.
  test_event_code text        CHECK (test_event_code ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- Which of an order's moments is TikTok's purchase; the others go by names of their own.
  purchase_at     text        NOT NULL DEFAULT 'placed'
                              CHECK (purchase_at IN ('placed', 'confirmed', 'delivered')),
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('marketing.tiktok_settings');

ALTER TABLE marketing.conversions
  DROP CONSTRAINT conversions_platform_check,
  ADD CONSTRAINT conversions_platform_check CHECK (platform IN ('meta', 'tiktok'));
