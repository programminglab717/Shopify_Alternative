-- 0230 · Gateway settlements (PAY-07)
-- Payment gateways pay a shop what its customers paid online later, less their fees and the tax
-- they withhold, with a statement of the payments it is for. A shop imports the statement as the
-- gateway sends it: each line is matched to a payment by the gateway's reference for it, and its
-- fees and tax are kept beside it. See ADR-491 in docs/architecture/13-decision-log.md.

CREATE TABLE payments.settlements (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  account_id  uuid        NOT NULL,
  -- The settlement's number or the payout's reference, when given.
  reference   text        CHECK (length(reference) BETWEEN 1 AND 100),
  line_count  integer     NOT NULL CHECK (line_count > 0),
  -- In minor units: what customers paid, the gateway's fees and the tax it withheld, and what it
  -- paid over; refunds it took back count against what customers paid.
  gross       bigint      NOT NULL,
  fees        bigint      NOT NULL CHECK (fees >= 0),
  tax         bigint      NOT NULL CHECK (tax >= 0),
  net         bigint      NOT NULL,
  actor_kind  text        NOT NULL CHECK (actor_kind IN ('staff', 'app')),
  actor_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, account_id) REFERENCES payments.gateway_accounts (shop_id, id)
);

-- A settlement is imported once: its reference from the same account again is refused.
CREATE UNIQUE INDEX settlements_reference_key ON payments.settlements (shop_id, account_id, reference)
  WHERE reference IS NOT NULL;
CREATE INDEX settlements_created_idx ON payments.settlements (shop_id, created_at DESC, id DESC);

CREATE TABLE payments.settlement_lines (
  shop_id         uuid    NOT NULL,
  settlement_id   uuid    NOT NULL,
  -- Its row in the file; the header is row 1 or below.
  file_row        integer NOT NULL CHECK (file_row > 1),
  -- The gateway's reference for the payment, as the statement writes it.
  transaction_ref text    NOT NULL CHECK (length(transaction_ref) BETWEEN 1 AND 200),
  -- The payment it matched, and its order. No foreign key to orders: they are the orders
  -- module's.
  session_id      uuid,
  order_id        uuid,
  outcome         text    NOT NULL CHECK (outcome IN (
                    'matched', 'differs', 'unmatched', 'repeated', 'refund')),
  gross           bigint  NOT NULL,
  fees            bigint  NOT NULL CHECK (fees >= 0),
  tax             bigint  NOT NULL CHECK (tax >= 0),
  -- What the payment was for, where it matched one.
  paid            bigint  CHECK (paid > 0),
  PRIMARY KEY (shop_id, settlement_id, file_row),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES payments.settlements (shop_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, session_id) REFERENCES payments.sessions (shop_id, id)
);

-- A payment is settled once.
CREATE UNIQUE INDEX settlement_lines_session_key ON payments.settlement_lines (shop_id, session_id)
  WHERE outcome IN ('matched', 'differs');

-- Payments found by the gateway's reference for them, as a statement writes it.
CREATE INDEX sessions_reference_idx ON payments.sessions (shop_id, account_id, lower(reference))
  WHERE reference IS NOT NULL;
CREATE INDEX sessions_gateway_ref_lower_idx
  ON payments.sessions (shop_id, account_id, lower(gateway_ref)) WHERE gateway_ref IS NOT NULL;

SELECT platform.enable_tenant_isolation('payments.settlements');
SELECT platform.enable_tenant_isolation('payments.settlement_lines');
