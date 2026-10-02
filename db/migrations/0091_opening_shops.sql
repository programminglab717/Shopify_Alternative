-- 0091 · Opening a shop
-- A signed-up user opens a shop of their own (ONB-01): the identity login adds it to
-- control.shops by its name and handle, makes the user its owner, and records shop.opened in the
-- outbox, in one transaction, for the worker to publish its storefront at its handle's subdomain.
-- Its currency and time zone are Pakistan's, the table's defaults (ONB-10). Its status, handle,
-- currency and time zone stay the control plane's to change.
-- See ADR-145 in docs/architecture/13-decision-log.md.

GRANT INSERT (id, name, handle) ON control.shops TO hatti_identity_role;
CREATE POLICY identity_open ON control.shops FOR INSERT TO hatti_identity_role WITH CHECK (true);

-- Shop opened: the one event the identity login records.
GRANT INSERT ON platform.outbox_events TO hatti_identity_role;
CREATE POLICY identity_shop_opened ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type = 'shop.opened' AND aggregate_type = 'shop' AND aggregate_id = shop_id);
