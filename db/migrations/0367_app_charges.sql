-- 0367 · App charges (DEV-05)
-- A public app (ADR-851) charges the shop it is installed on once, in rupees, as Shopify's apps do
-- with appPurchaseOneTimeCreate: it names what the charge is for and its price, and sends the
-- owner to approve it in the admin. Approved, it is an invoice of Hatti's, paid as plans are, and
-- the app's partner earns their share of what it paid, less the sales tax. On a development store
-- a charge is a test: approved, it is paid without money moving, and earns nothing.
-- See ADR-854 in docs/architecture/13-decision-log.md.

CREATE TABLE apps.app_charges (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The install asking: its token, and the app as its partner registered it.
  token_id      uuid        NOT NULL,
  public_app_id uuid        NOT NULL,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Paisa: Rs 50 to Rs 500,000.
  price         bigint      NOT NULL CHECK (price BETWEEN 5000 AND 50000000),
  -- Where the owner goes back to the app once they answered.
  return_url    text        NOT NULL CHECK (return_url ~ '^https://' AND char_length(return_url) <= 500),
  test          boolean     NOT NULL DEFAULT false,
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'paid', 'declined')),
  -- Once accepted: the invoice paying it; none for a test.
  invoice_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, token_id) REFERENCES apps.access_tokens (shop_id, id) ON DELETE CASCADE,
  CHECK (status <> 'accepted' OR invoice_id IS NOT NULL)
);

CREATE INDEX app_charges_token_idx ON apps.app_charges (shop_id, token_id, created_at DESC);

SELECT platform.enable_tenant_isolation('apps.app_charges');

-- An invoice may be for an app's charge: no plan, nor period; the charge, its app, and its name.
ALTER TABLE billing.invoices
  ADD COLUMN app_charge_id uuid,
  ADD COLUMN public_app_id uuid,
  ADD COLUMN charge_name   text CHECK (char_length(charge_name) BETWEEN 1 AND 100);
ALTER TABLE billing.invoices DROP CONSTRAINT invoices_reason_check;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_reason_check
  CHECK (reason IN ('change', 'renewal', 'credits', 'theme', 'app'));
ALTER TABLE billing.invoices DROP CONSTRAINT invoices_credits_check;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_credits_check
  CHECK ((reason IN ('credits', 'theme', 'app')) = (plan IS NULL)
         AND (reason IN ('credits', 'theme', 'app')) = (billing_interval IS NULL)),
  ADD CONSTRAINT invoices_app_check
  CHECK ((reason = 'app') = (app_charge_id IS NOT NULL)
         AND (reason = 'app') = (public_app_id IS NOT NULL)
         AND (reason = 'app') = (charge_name IS NOT NULL));

-- An app's share beside partners' of plans and designers' of themes.
ALTER TABLE identity.partner_earnings DROP CONSTRAINT partner_earnings_plan_check;
ALTER TABLE identity.partner_earnings
  ADD CONSTRAINT partner_earnings_plan_check
  CHECK (plan IN ('starter', 'growth', 'pro', 'theme', 'app'));

-- The share a paid app charge's invoice of shop `p_shop_id` earns the app's partner, recorded
-- once: 80% of what Hatti was paid, in paisa. For the shop of the transaction asking alone, and
-- SECURITY DEFINER, as identity.record_partner_earning.
CREATE FUNCTION identity.record_app_sale(
  p_shop_id uuid, p_invoice_id uuid, p_invoice_number bigint, p_app_id uuid, p_amount bigint)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO identity.partner_earnings
         (partner_id, shop_id, invoice_id, invoice_number, plan, invoice_amount, share_percent,
          amount)
  SELECT a.partner_id, p_shop_id, p_invoice_id, p_invoice_number, 'app', p_amount, 80,
         p_amount * 80 / 100
    FROM identity.partner_apps a
   WHERE a.id = p_app_id
     AND p_shop_id = platform.current_shop_id()
     AND p_amount > 0
  ON CONFLICT (invoice_id) DO NOTHING
  RETURNING amount
$$;

ALTER FUNCTION identity.record_app_sale(uuid, uuid, bigint, uuid, bigint)
  OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.record_app_sale(uuid, uuid, bigint, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.record_app_sale(uuid, uuid, bigint, uuid, bigint)
  TO hatti_app_role;
