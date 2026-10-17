-- 0236 · Partners' revenue share
-- A partner earns a share of what each store they brought pays Hatti for its plan, for as long as
-- it pays (PRT-02): 20% of each plan invoice paid by a store whose owner came by the partner's
-- referral code, or a development store they handed to its client (ADR-504); none of message
-- credit, nor of a store they still build. Hatti's people pay what is owed into the partner's
-- bank account, in rupees, and mark it paid with the transfer's reference.
-- See ADR-505 in docs/architecture/13-decision-log.md.

ALTER TABLE identity.partners
  ADD COLUMN payout_title text CHECK (char_length(payout_title) BETWEEN 1 AND 120),
  -- A Pakistani IBAN: PK, two check digits, the bank's four letters and 16 digits.
  ADD COLUMN payout_iban  text CHECK (payout_iban ~ '^PK[0-9]{2}[A-Z]{4}[0-9]{16}$'),
  ADD CHECK ((payout_title IS NULL) = (payout_iban IS NULL));

CREATE TABLE identity.partner_earnings (
  id               uuid        PRIMARY KEY DEFAULT platform.uuidv7(),
  partner_id       uuid        NOT NULL REFERENCES identity.partners (user_id) ON DELETE CASCADE,
  shop_id          uuid        NOT NULL REFERENCES control.shops (id),
  -- Each invoice earns once.
  invoice_id       uuid        NOT NULL UNIQUE,
  invoice_number   bigint      NOT NULL,
  plan             text        NOT NULL CHECK (plan IN ('starter', 'growth', 'pro')),
  -- Paisa: what the invoice was paid, and the partner's share of it.
  invoice_amount   bigint      NOT NULL CHECK (invoice_amount > 0),
  share_percent    smallint    NOT NULL CHECK (share_percent BETWEEN 1 AND 100),
  amount           bigint      NOT NULL CHECK (amount >= 0),
  earned_at        timestamptz NOT NULL DEFAULT now(),
  paid_out_at      timestamptz,
  payout_reference text        CHECK (char_length(payout_reference) BETWEEN 1 AND 100),
  CHECK ((paid_out_at IS NULL) = (payout_reference IS NULL))
);

CREATE INDEX partner_earnings_partner_idx ON identity.partner_earnings (partner_id, earned_at);
CREATE INDEX partner_earnings_owed_idx ON identity.partner_earnings (partner_id)
  WHERE paid_out_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON identity.partner_earnings TO hatti_identity_role;

-- The share a paid plan invoice of shop `p_shop_id` earns its partner, recorded once: what it is
-- in paisa, or nothing where no partner earns of the shop. For the shop of the transaction asking
-- alone, and SECURITY DEFINER, so that the worker, which never reads identity's tables, records no
-- more than this, as with identity.staff_phones.
CREATE FUNCTION identity.record_partner_earning(
  p_shop_id uuid, p_invoice_id uuid, p_invoice_number bigint, p_plan text, p_amount bigint)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO identity.partner_earnings
         (partner_id, shop_id, invoice_id, invoice_number, plan, invoice_amount, share_percent,
          amount)
  SELECT ps.partner_id, p_shop_id, p_invoice_id, p_invoice_number, p_plan, p_amount, 20,
         p_amount * 20 / 100
    FROM identity.partner_stores ps
   WHERE ps.shop_id = p_shop_id
     AND (ps.kind = 'referred' OR ps.transferred_at IS NOT NULL)
     AND p_shop_id = platform.current_shop_id()
     AND p_amount > 0
  ON CONFLICT (invoice_id) DO NOTHING
  RETURNING amount
$$;

ALTER FUNCTION identity.record_partner_earning(uuid, uuid, bigint, text, bigint)
  OWNER TO hatti_identity_role;
REVOKE ALL ON FUNCTION identity.record_partner_earning(uuid, uuid, bigint, text, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.record_partner_earning(uuid, uuid, bigint, text, bigint)
  TO hatti_app_role;
