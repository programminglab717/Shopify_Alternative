-- 0199 · An offer to shoppers who left a checkout (CHK-12)
-- A shop that reminds shoppers of the checkouts they left (ADR-393) may also offer, once, some
-- hours after the reminder went unanswered, one of its own discount codes: a percentage or an
-- amount off, chosen from its codes. The offer's link, a secret of its own kept as its SHA-256 as
-- the reminder's is, opens the same items with the code applied. The checkout keeps the code it
-- offered, as it was named then. See ADR-426 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.recovery_settings
  -- The pricing module's code offered; one deleted since offers nothing until another is chosen.
  ADD COLUMN offer_code_id     uuid,
  -- How many hours after the reminder.
  ADD COLUMN offer_after_hours integer CHECK (offer_after_hours IN (12, 24, 48)),
  ADD CONSTRAINT recovery_settings_offer_check
    CHECK ((offer_code_id IS NULL) = (offer_after_hours IS NULL)),
  -- No offer without the reminder before it.
  ADD CONSTRAINT recovery_settings_offer_reminded_check
    CHECK (offer_code_id IS NULL OR reminder_after_minutes IS NOT NULL);

ALTER TABLE checkout.checkouts
  ADD COLUMN offered_at       timestamptz,
  ADD COLUMN offer_token_hash bytea CHECK (octet_length(offer_token_hash) = 32),
  ADD COLUMN offer_code       text,
  ADD CONSTRAINT checkouts_offer_check
    CHECK ((offered_at IS NULL) = (offer_code IS NULL));

CREATE UNIQUE INDEX checkouts_offer_token_key ON checkout.checkouts (offer_token_hash)
  WHERE offer_token_hash IS NOT NULL;
-- Across shops, for the worker: those reminded, not yet offered, ordered or completed.
CREATE INDEX checkouts_to_offer_idx ON checkout.checkouts (reminded_at)
  WHERE reminded_at IS NOT NULL AND offered_at IS NULL AND completed_at IS NULL
    AND recovered_order_id IS NULL;

-- The shop and checkout of a reminder's secret or an offer's, for its link; and, for an offer's,
-- the code it offered. For active shops only, as before.
DROP FUNCTION checkout.resolve_reminder(bytea);

CREATE FUNCTION checkout.resolve_reminder(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, checkout_id uuid, offer_code text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.shop_id, c.id, NULL::text
    FROM checkout.checkouts c
    JOIN control.shops s ON s.id = c.shop_id
   WHERE c.reminder_token_hash = p_token_hash
     AND s.status = 'active'
  UNION ALL
  SELECT c.shop_id, c.id, c.offer_code
    FROM checkout.checkouts c
    JOIN control.shops s ON s.id = c.shop_id
   WHERE c.offer_token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION checkout.resolve_reminder(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION checkout.resolve_reminder(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkout.resolve_reminder(bytea) TO hatti_app_role;
