-- 0095 · Payments
-- Shops take payments online through their own gateway accounts (PAY-01): Safepay first, its
-- credentials sealed as couriers' are, so that the money goes to the shop and never through
-- Hatti (ADR-009). An order waiting for its money is paid from its page (PAY-04): each payment
-- session is a gateway's checkout for an amount of an order, recorded on the order once the
-- gateway says, in a signed return or webhook, that it is paid.
-- See ADR-151 in docs/architecture/13-decision-log.md.

CREATE SCHEMA payments;

GRANT USAGE ON SCHEMA payments TO hatti_app_role, hatti_system_role;

CREATE TABLE payments.gateway_accounts (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  gateway          text        NOT NULL CHECK (gateway ~ '^[a-z][a-z_]{1,29}$'),
  -- The gateway's test environment, whose payments move no money, or the real one.
  environment      text        NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- The account's credentials, sealed for it (SecretBox); never shown again.
  credentials      text        NOT NULL CHECK (char_length(credentials) <= 4000),
  -- The last four characters of its first credential, for staff to tell accounts apart.
  credentials_hint text        NOT NULL CHECK (char_length(credentials_hint) <= 4),
  -- No new payments once archived; payments already made stay recorded.
  archived_at      timestamptz,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('payments.gateway_accounts');

-- A gateway's one live account a shop.
CREATE UNIQUE INDEX gateway_accounts_live ON payments.gateway_accounts (shop_id, gateway)
  WHERE archived_at IS NULL;

CREATE TABLE payments.sessions (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  account_id   uuid        NOT NULL,
  order_id     uuid        NOT NULL,
  -- The account's environment when it started: a sandbox's payments pay no order.
  environment  text        NOT NULL CHECK (environment IN ('sandbox', 'production')),
  -- Minor units: what the customer was asked to pay.
  amount       bigint      NOT NULL CHECK (amount > 0),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Open until the gateway says it is paid; failed if the gateway would not start it.
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'failed')),
  -- The gateway's name for the payment, such as Safepay's tracker, and its page for it.
  gateway_ref  text        CHECK (char_length(gateway_ref) <= 200),
  checkout_url text        CHECK (char_length(checkout_url) <= 2000),
  -- Once paid: what was paid, in minor units, the gateway's reference for it, how Hatti heard,
  -- and what of it went towards what the order owed.
  paid_amount  bigint      CHECK (paid_amount > 0),
  reference    text        CHECK (char_length(reference) <= 200),
  paid_through text        CHECK (paid_through IN ('return', 'webhook')),
  applied      bigint      CHECK (applied >= 0),
  paid_at      timestamptz,
  error        text        CHECK (char_length(error) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, account_id) REFERENCES payments.gateway_accounts (shop_id, id),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK (status <> 'paid' OR (paid_amount IS NOT NULL AND paid_through IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('payments.sessions');

-- A gateway names each payment once.
CREATE UNIQUE INDEX sessions_gateway_ref ON payments.sessions (shop_id, account_id, gateway_ref)
  WHERE gateway_ref IS NOT NULL;
CREATE INDEX sessions_order ON payments.sessions (shop_id, order_id, created_at DESC);

-- The shop of a gateway account a webhook names in its address, found without knowing the shop:
-- the webhook is then checked with that account's secret, as that shop.
CREATE FUNCTION payments.resolve_gateway_account(p_account uuid)
  RETURNS TABLE (shop_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.shop_id FROM payments.gateway_accounts a WHERE a.id = p_account
$$;

ALTER FUNCTION payments.resolve_gateway_account(uuid) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION payments.resolve_gateway_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.resolve_gateway_account(uuid) TO hatti_app_role;
