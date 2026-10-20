-- 0293 · Products' images turned
-- An image shown cropped may be turned by quarter turns clockwise after its part is cut from the
-- whole, for a photo taken on its side: the whole image's crop, turned, where no part is cut.
-- See ADR-658 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.product_media
  ADD COLUMN crop_turns smallint NOT NULL DEFAULT 0 CHECK (crop_turns BETWEEN 0 AND 3),
  ADD CONSTRAINT product_media_turns_cropped CHECK (crop_turns = 0 OR crop_left IS NOT NULL);

-- A crop's name says its turns, as cropNameOf does, so that one replaced by the same part
-- turned otherwise goes as replaced crops do (ADR-630).
DROP TRIGGER product_media_crop_replaced ON catalog.product_media;
DROP FUNCTION catalog.media_crop_replaced();
DROP FUNCTION catalog.media_crop_name(integer, integer, integer, integer);

CREATE FUNCTION catalog.media_crop_name(
  left_ integer, top_ integer, width_ integer, height_ integer, turns_ smallint
)
  RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN left_ IS NULL THEN NULL
              ELSE 'crop-' || left_ || '-' || top_ || '-' || width_ || '-' || height_
                   || CASE WHEN turns_ > 0 THEN '-t' || turns_ ELSE '' END END
$$;

CREATE FUNCTION catalog.media_crop_replaced() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  replaced text := catalog.media_crop_name(
    OLD.crop_left, OLD.crop_top, OLD.crop_width, OLD.crop_height, OLD.crop_turns);
  shown text := catalog.media_crop_name(
    NEW.crop_left, NEW.crop_top, NEW.crop_width, NEW.crop_height, NEW.crop_turns);
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
  AFTER UPDATE OF crop_left, crop_top, crop_width, crop_height, crop_turns
  ON catalog.product_media
  FOR EACH ROW EXECUTE FUNCTION catalog.media_crop_replaced();
