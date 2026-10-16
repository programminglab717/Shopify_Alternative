-- 0211 · SMS campaigns
-- A shop's broadcasts go by SMS too (MKT-02): its own words, up to 320 characters, from Hatti's
-- shared sender to the customers of a segment who agreed to hear from it by SMS, with a link to
-- stop. A WhatsApp broadcast keeps one of the shop's templates; an SMS one keeps its words, and
-- the language of what Hatti adds to them, in template_language.
-- See ADR-458 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.broadcasts
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms')),
  ADD COLUMN text text CHECK (char_length(text) BETWEEN 1 AND 320),
  ALTER COLUMN template_id DROP NOT NULL,
  ALTER COLUMN template_name DROP NOT NULL,
  ALTER COLUMN template_body DROP NOT NULL,
  ADD CONSTRAINT broadcasts_channel_content CHECK (
    (channel = 'whatsapp' AND template_id IS NOT NULL AND template_name IS NOT NULL
      AND template_body IS NOT NULL AND text IS NULL)
    OR (channel = 'sms' AND text IS NOT NULL AND template_id IS NULL AND template_name IS NULL
      AND template_body IS NULL)
  );

-- An SMS campaign's message carries a link to stop, by its ID alone (ADR-458): the shop it came
-- from, for the page the link opens, found across shops as WhatsApp's replies are (MSG-09).
CREATE INDEX messages_stop_links ON messaging.messages (id) WHERE kind = 'sms_broadcast';

CREATE FUNCTION messaging.resolve_stop_link(p_id uuid)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.shop_id FROM messaging.messages m WHERE m.id = p_id AND m.kind = 'sms_broadcast'
$$;

ALTER FUNCTION messaging.resolve_stop_link(uuid) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_stop_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_stop_link(uuid) TO hatti_app_role;
