-- 0339 · Uploaded videos by their URLs
-- A video may be given by an https URL the worker fetches, as Shopify's productCreateMedia takes
-- one, and as a Shopify store's videos come when it moves (ADR-794): it has no staged upload of
-- the shop's, and so no source key, until the worker keeps its clean copy.

ALTER TABLE catalog.product_media
  DROP CONSTRAINT product_media_kind_check,
  ADD CONSTRAINT product_media_kind_check CHECK (
    CASE media_type
      WHEN 'image' THEN preview_source_url IS NULL AND video_host IS NULL AND video_size IS NULL
      WHEN 'external_video' THEN video_host IS NOT NULL AND video_external_id IS NOT NULL
                                 AND video_size IS NULL AND crop_left IS NULL
      ELSE video_host IS NULL
           AND crop_left IS NULL
           AND (status <> 'ready'
                OR (video_size IS NOT NULL AND video_width IS NOT NULL
                    AND video_height IS NOT NULL AND video_duration_ms IS NOT NULL))
    END);
