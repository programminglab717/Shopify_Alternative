-- 0196 · A shop's own WhatsApp templates
-- The marketing templates a shop writes for broadcasts from its own number (MKT-01): each sent to
-- Meta for approval on the WhatsApp Business Account the shop connected (ADR-419), with Meta's ID
-- for it, and kept as Meta says it stands, from its webhook or when the shop asks again.
-- See ADR-420 in docs/architecture/13-decision-log.md.

CREATE TABLE messaging.whatsapp_templates (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The account it was sent to: the shop's templates are those of the account it has now.
  business_account_id text        NOT NULL CHECK (business_account_id ~ '^[0-9]{1,30}$'),
  -- Meta's: lowercase letters, digits and underscores.
  name                text        NOT NULL CHECK (name ~ '^[a-z0-9_]{1,100}$'),
  language            text        NOT NULL CHECK (language IN ('en', 'ur')),
  header              text        CHECK (char_length(header) BETWEEN 1 AND 60),
  -- {{1}}, if anywhere, is the customer's first name.
  body                text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1024),
  footer              text        CHECK (char_length(footer) BETWEEN 1 AND 60),
  button_text         text        CHECK (char_length(button_text) BETWEEN 1 AND 25),
  button_url          text        CHECK (char_length(button_url) <= 2000),
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected', 'paused',
                                                    'disabled')),
  meta_template_id    text        NOT NULL CHECK (meta_template_id ~ '^[0-9]{1,30}$'),
  rejected_reason     text        CHECK (char_length(rejected_reason) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, business_account_id, name, language),
  CHECK ((button_text IS NULL) = (button_url IS NULL))
);

SELECT platform.enable_tenant_isolation('messaging.whatsapp_templates');

CREATE INDEX whatsapp_templates_latest ON messaging.whatsapp_templates (shop_id, created_at DESC);
CREATE INDEX whatsapp_templates_meta ON messaging.whatsapp_templates (meta_template_id);

-- The shop whose template WhatsApp's webhook names by Meta's ID, found before any shop is known,
-- as messaging.resolve_provider_messages finds messages (0092).
CREATE FUNCTION messaging.resolve_whatsapp_template(p_meta_template_id text)
  RETURNS TABLE (shop_id uuid, template_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.shop_id, t.id
    FROM messaging.whatsapp_templates t
   WHERE t.meta_template_id = p_meta_template_id
$$;

ALTER FUNCTION messaging.resolve_whatsapp_template(text) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION messaging.resolve_whatsapp_template(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.resolve_whatsapp_template(text) TO hatti_app_role;
