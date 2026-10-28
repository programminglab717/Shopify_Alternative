-- 0366 · Theme store (OS-20)
-- Pakistan's designers, as Hatti's partners (ADR-504), offer themes they built on a development
-- store to every shop: free, or for a price in rupees. A theme listed is one of Hatti's themes
-- with the designer's own JSON files over it (ADR-039), copied when it is offered, and shown in
-- the store once Hatti has looked at it. A shop installs a free one at once; a paid one is an
-- invoice of Hatti's, paid as plans are, after which the shop installs it as often as it likes,
-- and the designer earns their share of what it paid, less the sales tax.
-- See ADR-853 in docs/architecture/13-decision-log.md.

CREATE TABLE identity.partner_themes (
  id            uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  partner_id    uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  -- The development store and theme it was offered from, to offer again as it changes.
  source_shop   uuid        NOT NULL REFERENCES control.shops (id),
  source_theme  uuid        NOT NULL,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description   text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  -- Hatti's theme it is built on, and the designer's files over it: { filename: body }.
  base          text        NOT NULL CHECK (char_length(base) BETWEEN 1 AND 60),
  files         jsonb       NOT NULL CHECK (jsonb_typeof(files) = 'object'),
  -- Paisa: nothing for a free theme; else Rs 1,000 to Rs 100,000.
  price         bigint      NOT NULL CHECK (price = 0 OR price BETWEEN 100000 AND 10000000),
  -- When Hatti looked at it and listed it; null while it waits, and again once it changes.
  listed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_shop, source_theme)
);

CREATE INDEX partner_themes_partner_idx ON identity.partner_themes (partner_id, created_at);
CREATE INDEX partner_themes_listed_idx ON identity.partner_themes (listed_at)
  WHERE listed_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.partner_themes TO hatti_identity_role;

-- An invoice may be for a theme: no plan, nor period; the theme it buys, by its listing and as it
-- was named then.
ALTER TABLE billing.invoices
  ADD COLUMN theme_id   uuid,
  ADD COLUMN theme_name text CHECK (char_length(theme_name) BETWEEN 1 AND 60);
ALTER TABLE billing.invoices DROP CONSTRAINT invoices_reason_check;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_reason_check
  CHECK (reason IN ('change', 'renewal', 'credits', 'theme'));
ALTER TABLE billing.invoices DROP CONSTRAINT invoices_credits_check;
ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_credits_check
  CHECK ((reason IN ('credits', 'theme')) = (plan IS NULL)
         AND (reason IN ('credits', 'theme')) = (billing_interval IS NULL)),
  ADD CONSTRAINT invoices_theme_check
  CHECK ((reason = 'theme') = (theme_id IS NOT NULL)
         AND (reason = 'theme') = (theme_name IS NOT NULL));

-- One invoice for a plan waits to be paid at a time, one for credits, and one for a theme.
DROP INDEX billing.invoices_open;
CREATE UNIQUE INDEX invoices_open ON billing.invoices
  (shop_id, (CASE WHEN reason IN ('change', 'renewal') THEN 'plan' ELSE reason END))
  WHERE status = 'open';
CREATE INDEX invoices_themes_paid ON billing.invoices (shop_id, theme_id)
  WHERE reason = 'theme' AND status = 'paid';

-- A designer's share of a theme sold, beside partners' share of plans.
ALTER TABLE identity.partner_earnings DROP CONSTRAINT partner_earnings_plan_check;
ALTER TABLE identity.partner_earnings
  ADD CONSTRAINT partner_earnings_plan_check
  CHECK (plan IN ('starter', 'growth', 'pro', 'theme'));

-- The share a paid theme invoice of shop `p_shop_id` earns the theme's designer, recorded once:
-- 80% of what Hatti was paid, in paisa; nothing for a theme no longer listed by anyone. For the
-- shop of the transaction asking alone, and SECURITY DEFINER, as identity.record_partner_earning.
CREATE FUNCTION identity.record_theme_sale(
  p_shop_id uuid, p_invoice_id uuid, p_invoice_number bigint, p_theme_id uuid, p_amount bigint)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO identity.partner_earnings
         (partner_id, shop_id, invoice_id, invoice_number, plan, invoice_amount, share_percent,
          amount)
  SELECT t.partner_id, p_shop_id, p_invoice_id, p_invoice_number, 'theme', p_amount, 80,
         p_amount * 80 / 100
    FROM identity.partner_themes t
   WHERE t.id = p_theme_id
     AND p_shop_id = platform.current_shop_id()
     AND p_amount > 0
  ON CONFLICT (invoice_id) DO NOTHING
  RETURNING amount
$$;

ALTER FUNCTION identity.record_theme_sale(uuid, uuid, bigint, uuid, bigint)
  OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.record_theme_sale(uuid, uuid, bigint, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.record_theme_sale(uuid, uuid, bigint, uuid, bigint)
  TO hatti_app_role;
