-- 0021 · Shop handles
-- Every shop has a handle, which names its storefront on the platform's domain: {handle}.hatti.pk.
-- Handles are lowercase DNS labels, unique across the platform. The control plane will choose one
-- with the merchant when a shop is created; until then, a shop made without one gets a random one,
-- as shops already made do here. See ADR-037 in docs/architecture/13-decision-log.md.

ALTER TABLE control.shops
  ADD COLUMN handle text NOT NULL DEFAULT 'shop-' || substr(md5(gen_random_uuid()::text), 1, 12)
    CONSTRAINT shops_handle_check
      CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' AND handle NOT LIKE '%--%'),
  ADD CONSTRAINT shops_handle_key UNIQUE (handle);

-- Request code may rename its shop. Its handle, status, currency and time zone are the control
-- plane's to change.
REVOKE UPDATE ON control.shops FROM hatti_app_role;
GRANT UPDATE (name, updated_at) ON control.shops TO hatti_app_role;
