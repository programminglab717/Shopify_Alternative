-- 0160 · Products' images cropped
-- The merchant crops a product's image and marks what matters in it (CAT-02): the image is shown
-- cropped, at every size and in every format, its clean copy kept whole so that it can be cropped
-- again; themes keep the focal point in sight as they fill a frame with it. See ADR-257 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.product_media
  -- The part shown, in the clean copy's pixels from its top left; null for the whole image.
  ADD COLUMN crop_left   integer CHECK (crop_left >= 0),
  ADD COLUMN crop_top    integer CHECK (crop_top >= 0),
  ADD COLUMN crop_width  integer CHECK (crop_width > 0),
  ADD COLUMN crop_height integer CHECK (crop_height > 0),
  -- The focal point, in percent of the image shown, across and down; null for none set.
  ADD COLUMN focal_x     numeric(5, 2) CHECK (focal_x BETWEEN 0 AND 100),
  ADD COLUMN focal_y     numeric(5, 2) CHECK (focal_y BETWEEN 0 AND 100),
  -- Only a ready image is cropped, inside itself.
  ADD CONSTRAINT product_media_crop_check
    CHECK ((crop_left IS NULL) = (crop_top IS NULL)
           AND (crop_left IS NULL) = (crop_width IS NULL)
           AND (crop_left IS NULL) = (crop_height IS NULL)
           AND (crop_left IS NULL
                OR (status = 'ready' AND crop_left + crop_width <= width
                    AND crop_top + crop_height <= height))),
  ADD CONSTRAINT product_media_focal_check CHECK ((focal_x IS NULL) = (focal_y IS NULL));
