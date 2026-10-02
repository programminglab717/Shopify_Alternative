-- 0098 · Billing
-- What shops pay Hatti (BIL-01): a plan, Free or one priced in rupees by the month or the year,
-- paid through Hatti's own payment gateway account. A shop without a subscription is on Free.
-- Each paid period is an invoice, numbered across Hatti; each try at paying it through the
-- gateway is recorded before the shop's staff leave for the gateway's page, as orders' payments
-- are (ADR-151), and the gateway's signed return or webhook, whichever comes first, pays it once.
-- See ADR-154 in docs/architecture/13-decision-log.md.

CREATE SCHEMA billing;

GRANT USAGE ON SCHEMA billing TO hatti_app_role, hatti_system_role;

CREATE TABLE billing.subscriptions (
  shop_id          uuid        NOT NULL,
  plan             text        NOT NULL CHECK (plan IN ('free', 'starter', 'growth', 'pro')),
  -- How a paid plan is paid for, and the period paid for: none on Free.
  billing_interval text        CHECK (billing_interval IN ('monthly', 'yearly')),
  period_start     timestamptz,
  period_end       timestamptz,
  -- A smaller plan, or Free, chosen to begin when the period ends.
  next_plan        text        CHECK (next_plan IN ('free', 'starter', 'growth', 'pro')),
  next_interval    text        CHECK (next_interval IN ('monthly', 'yearly')),
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id),
  CHECK ((plan = 'free') = (billing_interval IS NULL)),
  CHECK ((plan = 'free') = (period_start IS NULL) AND (plan = 'free') = (period_end IS NULL)),
  CHECK (period_end IS NULL OR period_end > period_start),
  CHECK (next_plan IS NULL OR (next_plan = 'free') = (next_interval IS NULL)),
  CHECK (next_plan IS NULL OR plan <> 'free')
);

SELECT platform.enable_tenant_isolation('billing.subscriptions');

-- Invoices are numbered across Hatti, as the seller's own must be.
CREATE SEQUENCE billing.invoice_numbers;
GRANT USAGE ON SEQUENCE billing.invoice_numbers TO hatti_app_role, hatti_system_role;

CREATE TABLE billing.invoices (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  number           bigint      NOT NULL DEFAULT nextval('billing.invoice_numbers'),
  -- A plan chosen now, or the plan's next period.
  reason           text        NOT NULL CHECK (reason IN ('change', 'renewal')),
  plan             text        NOT NULL CHECK (plan IN ('starter', 'growth', 'pro')),
  billing_interval text        NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  -- Paisa: the plan's price for the period, less what was left unused of the period it cuts
  -- short, and what is owed.
  price            bigint      NOT NULL CHECK (price > 0),
  credit           bigint      NOT NULL DEFAULT 0 CHECK (credit >= 0 AND credit < price),
  amount           bigint      GENERATED ALWAYS AS (price - credit) STORED,
  currency         text        NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  -- Open until paid; void once another takes its place or the plan it was for ended.
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  -- Once paid: the gateway's reference for the payment.
  reference        text        CHECK (char_length(reference) <= 200),
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (number),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('billing.invoices');

-- One invoice waits to be paid at a time.
CREATE UNIQUE INDEX invoices_open ON billing.invoices (shop_id) WHERE status = 'open';
CREATE INDEX invoices_shop ON billing.invoices (shop_id, created_at DESC);

CREATE TABLE billing.payments (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  invoice_id   uuid        NOT NULL,
  -- Hatti's own account with the gateway, in its environment then.
  gateway      text        NOT NULL CHECK (gateway ~ '^[a-z][a-z_]{1,29}$'),
  environment  text        NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- Paisa: what the invoice asked for when it began.
  amount       bigint      NOT NULL CHECK (amount > 0),
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'failed')),
  -- The gateway's name for the payment and its page for it; or why it would not start it.
  gateway_ref  text        CHECK (char_length(gateway_ref) <= 200),
  checkout_url text        CHECK (char_length(checkout_url) <= 2000),
  error        text        CHECK (char_length(error) <= 1000),
  paid_amount  bigint      CHECK (paid_amount > 0),
  paid_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, invoice_id) REFERENCES billing.invoices (shop_id, id),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('billing.payments');

-- Hatti's gateway names each payment once.
CREATE UNIQUE INDEX payments_gateway_ref ON billing.payments (gateway, gateway_ref)
  WHERE gateway_ref IS NOT NULL;
CREATE INDEX payments_invoice ON billing.payments (shop_id, invoice_id, created_at DESC);

-- The shop of an invoice, or of a payment the gateway names, found without knowing the shop:
-- the gateway's return and webhook name only these, and are checked with Hatti's own secrets.
CREATE FUNCTION billing.resolve_invoice(p_invoice uuid)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.shop_id FROM billing.invoices i WHERE i.id = p_invoice
$$;

CREATE FUNCTION billing.resolve_payment(p_gateway text, p_ref text)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.shop_id FROM billing.payments p WHERE p.gateway = p_gateway AND p.gateway_ref = p_ref
$$;

ALTER FUNCTION billing.resolve_invoice(uuid) OWNER TO hatti_system_role;
ALTER FUNCTION billing.resolve_payment(text, text) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION billing.resolve_invoice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.resolve_payment(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.resolve_invoice(uuid) TO hatti_app_role;
GRANT EXECUTE ON FUNCTION billing.resolve_payment(text, text) TO hatti_app_role;
