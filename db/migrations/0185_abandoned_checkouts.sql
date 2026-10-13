-- 0185 · Abandoned checkouts and their reminder (CHK-12)
-- A checkout keeps the name and number its shopper typed, as they typed it or posted the page,
-- with the items and their subtotal then, so that a shop can see who left without ordering and,
-- where it chooses, remind them once on WhatsApp, after the delay it sets, with a link back to
-- those items. The link's secret is kept as its SHA-256. A checkout with a number is kept 30 days
-- for this, after its page has expired; an order the same number places within 7 days of its
-- reminder recovers it. See ADR-393 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.checkouts
  ADD COLUMN contact_name        text,
  -- As the orders module keeps numbers: +923001234567.
  ADD COLUMN contact_phone       text,
  ADD COLUMN contact_at          timestamptz,
  -- [{variantId, title, variantTitle, quantity}], as the cart held them then.
  ADD COLUMN contact_lines       jsonb,
  ADD COLUMN contact_subtotal    bigint,
  ADD COLUMN kept_until          timestamptz,
  ADD COLUMN reminded_at         timestamptz,
  ADD COLUMN reminder_token_hash bytea CHECK (octet_length(reminder_token_hash) = 32),
  ADD COLUMN recovered_order_id  uuid,
  ADD CONSTRAINT checkouts_contact_check
    CHECK ((contact_phone IS NULL) = (contact_at IS NULL));

-- The shop's abandoned checkouts, the latest first, and those to remind.
CREATE INDEX checkouts_contact_idx ON checkout.checkouts (shop_id, contact_at DESC)
  WHERE contact_phone IS NOT NULL;
-- Across shops, for the worker: those not reminded or completed yet.
CREATE INDEX checkouts_to_remind_idx ON checkout.checkouts (contact_at)
  WHERE contact_phone IS NOT NULL AND reminded_at IS NULL AND completed_at IS NULL;
CREATE UNIQUE INDEX checkouts_reminder_token_key ON checkout.checkouts (reminder_token_hash)
  WHERE reminder_token_hash IS NOT NULL;

-- Whether, and how long after the shopper left, a shop reminds them: null for never.
CREATE TABLE checkout.recovery_settings (
  shop_id                uuid        PRIMARY KEY,
  reminder_after_minutes integer     CHECK (reminder_after_minutes IN (30, 60, 180, 600)),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('checkout.recovery_settings');

-- The shop and checkout of a reminder's secret, for its link, which knows no shop until it finds
-- one: for active shops only, as resolve_checkout.
CREATE FUNCTION checkout.resolve_reminder(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, checkout_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.shop_id, c.id
    FROM checkout.checkouts c
    JOIN control.shops s ON s.id = c.shop_id
   WHERE c.reminder_token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION checkout.resolve_reminder(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION checkout.resolve_reminder(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkout.resolve_reminder(bytea) TO hatti_app_role;
