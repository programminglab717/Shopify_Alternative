-- 0345 · Referrals
-- A shop's referral programme (MKT-07): each customer has a code of their own, and a link to the
-- online store with it. Once a friend's first order, placed from that link, is delivered and
-- paid, both are given store credit, unless the checks against fraud refuse it: the referrer's
-- own order, a customer who ordered before, the referrer's device or address, or more than the
-- month allows. Each order's outcome is kept, once. See ADR-807 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE messaging.referral_programs (
  shop_id          uuid        PRIMARY KEY,
  enabled          boolean     NOT NULL DEFAULT false,
  -- Store credit given to the customer whose code brought the order, in minor units.
  referrer_credit  bigint      NOT NULL CHECK (referrer_credit BETWEEN 1000 AND 1000000),
  -- Store credit given to the friend for their next order; 0: none.
  friend_credit    bigint      NOT NULL CHECK (friend_credit BETWEEN 0 AND 1000000),
  -- How many days the credit lasts.
  credit_days      smallint    NOT NULL CHECK (credit_days BETWEEN 7 AND 365),
  -- What the friend's goods must come to, after its discount, in minor units; 0: anything.
  minimum_order    bigint      NOT NULL DEFAULT 0 CHECK (minimum_order BETWEEN 0 AND 100000000),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('messaging.referral_programs');

CREATE TABLE messaging.referral_codes (
  shop_id      uuid        NOT NULL,
  customer_id  uuid        NOT NULL,
  -- Eight letters and digits, none mistaken for another.
  code         text        NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, customer_id),
  UNIQUE (shop_id, code)
);

SELECT platform.enable_tenant_isolation('messaging.referral_codes');

CREATE TABLE messaging.referrals (
  shop_id          uuid        NOT NULL,
  -- The friend's order the code brought.
  order_id         uuid        NOT NULL,
  referrer_id      uuid        NOT NULL,
  friend_id        uuid        NOT NULL,
  outcome          text        NOT NULL CHECK (outcome IN ('rewarded', 'refused')),
  reason           text        CHECK (reason IN ('own_code', 'not_first_order', 'same_device',
                                                 'same_address', 'referrer_unproven',
                                                 'monthly_limit', 'below_minimum')),
  -- What each was given, in minor units.
  referrer_credit  bigint      NOT NULL DEFAULT 0,
  friend_credit    bigint      NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, order_id),
  CHECK ((outcome = 'refused') = (reason IS NOT NULL))
);

SELECT platform.enable_tenant_isolation('messaging.referrals');

-- A referrer's referrals, latest first: the month's count, and the admin's list.
CREATE INDEX referrals_referrer ON messaging.referrals (shop_id, referrer_id, created_at DESC);
CREATE INDEX referrals_latest ON messaging.referrals (shop_id, created_at DESC);
