-- 0258 · Google Analytics for ads
-- Orders reach Google's ads too (MKT-10): a shop connects its Google Analytics web stream with a
-- Measurement Protocol API secret, and the worker sends each order placed through checkout to it
-- as it is placed, confirmed and delivered, beside Meta's and TikTok's, the moment the shop
-- chooses as its purchase, for Google Ads to import as a conversion. See ADR-547 in
-- docs/architecture/13-decision-log.md.

-- The shop's Google Analytics web stream and the API secret Google Analytics made for it.
CREATE TABLE marketing.google_settings (
  shop_id        uuid        PRIMARY KEY,
  -- As Google Analytics shows it: "G-ABC123XYZ9".
  measurement_id text        NOT NULL CHECK (measurement_id ~ '^G-[A-Z0-9]{4,20}$'),
  -- Sealed for the shop alone, and never shown again.
  api_secret     text        NOT NULL,
  -- Its last four characters, to tell secrets apart by.
  secret_hint    text        NOT NULL CHECK (char_length(secret_hint) = 4),
  -- Which of an order's moments is Google's purchase; the others go by names of their own.
  purchase_at    text        NOT NULL DEFAULT 'placed'
                             CHECK (purchase_at IN ('placed', 'confirmed', 'delivered')),
  version        integer     NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('marketing.google_settings');

ALTER TABLE marketing.conversions
  DROP CONSTRAINT conversions_platform_check,
  ADD CONSTRAINT conversions_platform_check CHECK (platform IN ('meta', 'tiktok', 'google'));
