-- 0102 · Product images
-- Hatti keeps products' images itself (CAT-02): the worker reads each from the file the shop
-- uploaded, or fetches it from the URL it gave, checks that it is an image to show, and keeps a
-- clean copy of it, without the metadata a phone adds, at most 4,096 pixels a side; the core
-- serves it at the widths and in the formats browsers ask for. A media's images go from storage
-- when it does. See ADR-158 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.product_media
  -- A file the shop uploaded (ADR-079): its key in storage, under the shop's own prefix; null for
  -- an image fetched from its URL.
  ADD COLUMN source_key      text,
  -- The clean copy, once ready: JPEG, or PNG for an image some of which is see-through.
  ADD COLUMN image_format    text    CHECK (image_format IN ('jpeg', 'png')),
  ADD COLUMN image_size      integer CHECK (image_size > 0),
  -- The worker's tries, and when it is due to try (again); never once ready or failed.
  ADD COLUMN attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz DEFAULT now(),
  -- Why it failed, in Shopify's MediaError's words: a code, and a message for the merchant.
  ADD COLUMN error_code      text,
  ADD COLUMN error_message   text    CHECK (char_length(error_message) <= 500),
  -- An upload's location, http in development, as well as https URLs.
  DROP CONSTRAINT product_media_source_url_check,
  ADD CONSTRAINT product_media_source_url_check
    CHECK (source_url ~ '^https?://' AND length(source_url) <= 2048),
  ADD CONSTRAINT product_media_source_key_check
    CHECK (source_key LIKE 'shops/' || shop_id || '/%'),
  ADD CONSTRAINT product_media_due_check
    CHECK ((status IN ('uploaded', 'processing')) = (next_attempt_at IS NOT NULL)),
  ADD CONSTRAINT product_media_ready_check
    CHECK ((status = 'ready') = (image_format IS NOT NULL)
           AND (status <> 'ready' OR (width IS NOT NULL AND height IS NOT NULL
                                      AND image_size IS NOT NULL))),
  ADD CONSTRAINT product_media_failed_check
    CHECK ((status = 'failed') = (error_code IS NOT NULL));

-- The media the worker has to process, across shops.
CREATE INDEX product_media_due_idx ON catalog.product_media (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

-- Media gone, with their product or alone, whose images the worker removes from storage and the
-- edge's cache.
CREATE TABLE catalog.media_removals (
  shop_id    uuid        NOT NULL,
  media_id   uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, media_id)
);

SELECT platform.enable_tenant_isolation('catalog.media_removals');

CREATE INDEX media_removals_created_idx ON catalog.media_removals (created_at);

CREATE FUNCTION catalog.media_removed() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.media_removals (shop_id, media_id)
  SELECT shop_id, id FROM removed
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;

CREATE TRIGGER product_media_removed
  AFTER DELETE ON catalog.product_media
  REFERENCING OLD TABLE AS removed
  FOR EACH STATEMENT EXECUTE FUNCTION catalog.media_removed();
