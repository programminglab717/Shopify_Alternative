-- 0008 · Customers
-- Phone-first customer profiles and the merchant's blocklist. A customer is whoever a mobile number
-- belongs to (ADR-011): orders find or create their customer by number. What customers have
-- ordered is worked out from their orders when asked for (ADR-023), so nothing here repeats it.
-- See docs/architecture/03-multi-tenancy-and-data.md and docs/engineering/conventions.md.

CREATE SCHEMA customers;

GRANT USAGE ON SCHEMA customers TO hatti_app_role, hatti_system_role;

-- ---------------------------------------------------------------------------------------------
-- Customers: one per mobile number per shop. Orders create them with the name and email they
-- carry; after that, only staff and apps change a profile.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE customers.customers (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL,
  -- Who they are: a Pakistani mobile number in E.164 form.
  phone       text        NOT NULL CHECK (phone ~ '^\+923[0-9]{9}$'),
  name        text        CHECK (length(name) BETWEEN 1 AND 255),
  email       text        CHECK (length(email) BETWEEN 3 AND 254),
  note        text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  tags        text[]      NOT NULL DEFAULT '{}',
  -- Normalised by searchKey() in @hatti/pk: the name and email.
  search_text text        NOT NULL DEFAULT '',
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT customers_phone_key UNIQUE (shop_id, phone)
);

SELECT platform.enable_tenant_isolation('customers.customers');

-- ---------------------------------------------------------------------------------------------
-- The blocklist: numbers whose orders are held for staff to review. Kept by number rather than
-- by customer, so that a number passed around in a seller group can be blocked before it orders.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE customers.blocklist_entries (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  phone      text        NOT NULL CHECK (phone ~ '^\+923[0-9]{9}$'),
  reason     text        NOT NULL
             CHECK (reason IN ('fake_orders', 'refused_deliveries', 'abuse', 'fraud', 'other')),
  note       text        NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  -- Who blocked the number, or last changed why: the access token or the staff member.
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id   uuid        NOT NULL,
  version    integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT blocklist_entries_phone_key UNIQUE (shop_id, phone)
);

SELECT platform.enable_tenant_isolation('customers.blocklist_entries');
