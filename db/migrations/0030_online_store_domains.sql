-- 0030 · Online store domains
-- A shop's own domains, such as www.zarifashions.pk, beside its address on the platform's domain.
-- A domain serves the shop's storefront once DNS points it at the platform, which is checked when
-- the shop asks; the shop's primary domain is where the storefront sends shoppers. A domain is one
-- shop's on the whole platform. See ADR-048 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.domains (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Lowercase ASCII, as DNS has it: internationalised names in their xn-- form.
  host        text        NOT NULL CHECK (
                length(host) <= 253
                AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
              ),
  -- When DNS last pointed it at the platform; null until it has.
  verified_at timestamptz,
  is_primary  boolean     NOT NULL DEFAULT false CHECK (NOT is_primary OR verified_at IS NOT NULL),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- One shop's across the platform, whichever shop asks: request code sees only its own shop's
-- rows, but the index sees them all.
CREATE UNIQUE INDEX domains_host_key ON online_store.domains (host);
CREATE UNIQUE INDEX domains_primary_key ON online_store.domains (shop_id) WHERE is_primary;

SELECT platform.enable_tenant_isolation('online_store.domains');
