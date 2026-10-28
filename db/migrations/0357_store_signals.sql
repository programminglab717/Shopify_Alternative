-- 0357 · Signs of a scam store (TNS-02)
-- The worker looks across stores each day for what scam stores do here, for Hatti's people to
-- look into (ADR-842): a young store keeping customers' money for orders it doesn't ship; a
-- catalogue copied from another store, its photos the same to the byte and its titles word for
-- word; and a name that is a verified store's. Each sign is kept once a store and kind while it
-- stands, with what was found; one Hatti's people clear isn't raised again for that store.
-- See ADR-842 in docs/architecture/13-decision-log.md.

CREATE TABLE trust.store_signals (
  shop_id       uuid        NOT NULL REFERENCES control.shops (id) ON DELETE CASCADE,
  kind          text        NOT NULL
                            CHECK (kind IN ('prepaid_unshipped', 'cloned_catalogue', 'impersonation')),
  -- What was found, for the people looking into it: counts, amounts, the other store.
  detail        jsonb       NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Looked into and found nothing wrong: by whom and why.
  cleared_at    timestamptz,
  cleared_by    text        CHECK (char_length(cleared_by) BETWEEN 1 AND 100),
  note          text        CHECK (char_length(note) BETWEEN 1 AND 1000),
  PRIMARY KEY (shop_id, kind),
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);

SELECT platform.enable_tenant_isolation('trust.store_signals');

-- What the scan matches photos and titles by, across stores.
CREATE INDEX product_media_fingerprint ON catalog.product_media (image_size, width, height)
  WHERE image_size IS NOT NULL AND width IS NOT NULL;
CREATE INDEX products_title_key ON catalog.products (lower(title));
