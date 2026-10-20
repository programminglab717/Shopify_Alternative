-- 0285 · Old crops' files removed
-- An image cropped again, or shown whole again, leaves its crop before named for the worker to
-- remove from storage once no page cached at the edge can still name it; a crop shown again
-- before then is kept. See ADR-630 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.media_crop_removals (
  shop_id    uuid        NOT NULL,
  media_id   uuid        NOT NULL,
  -- Its folder's name, as its images' paths have it: "crop-120-0-800-800".
  crop       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, media_id, crop)
);

SELECT platform.enable_tenant_isolation('catalog.media_crop_removals');

CREATE INDEX media_crop_removals_created_idx ON catalog.media_crop_removals (created_at);

CREATE FUNCTION catalog.media_crop_name(
  left_ integer, top_ integer, width_ integer, height_ integer
)
  RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN left_ IS NULL THEN NULL
              ELSE 'crop-' || left_ || '-' || top_ || '-' || width_ || '-' || height_ END
$$;

CREATE FUNCTION catalog.media_crop_replaced() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  replaced text :=
    catalog.media_crop_name(OLD.crop_left, OLD.crop_top, OLD.crop_width, OLD.crop_height);
  shown text :=
    catalog.media_crop_name(NEW.crop_left, NEW.crop_top, NEW.crop_width, NEW.crop_height);
BEGIN
  IF replaced IS NOT DISTINCT FROM shown THEN
    RETURN NULL;
  END IF;
  IF replaced IS NOT NULL THEN
    INSERT INTO catalog.media_crop_removals (shop_id, media_id, crop)
    VALUES (OLD.shop_id, OLD.id, replaced)
    ON CONFLICT (shop_id, media_id, crop) DO UPDATE SET created_at = now();
  END IF;
  -- Shown again before it went: kept.
  IF shown IS NOT NULL THEN
    DELETE FROM catalog.media_crop_removals
     WHERE shop_id = NEW.shop_id AND media_id = NEW.id AND crop = shown;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER product_media_crop_replaced
  AFTER UPDATE OF crop_left, crop_top, crop_width, crop_height ON catalog.product_media
  FOR EACH ROW EXECUTE FUNCTION catalog.media_crop_replaced();
