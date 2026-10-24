-- 0338 · Uploaded videos without a preview image
-- A video the shop uploads may come without the image shown before it plays: the worker takes a
-- frame of it with ffmpeg (ADR-793). The rest of what each kind of media keeps stays as 0161 had it.

ALTER TABLE catalog.product_media
  DROP CONSTRAINT product_media_kind_check,
  ADD CONSTRAINT product_media_kind_check CHECK (
    CASE media_type
      WHEN 'image' THEN preview_source_url IS NULL AND video_host IS NULL AND video_size IS NULL
      WHEN 'external_video' THEN video_host IS NOT NULL AND video_external_id IS NOT NULL
                                 AND video_size IS NULL AND crop_left IS NULL
      ELSE source_key IS NOT NULL AND video_host IS NULL
           AND crop_left IS NULL
           AND (status <> 'ready'
                OR (video_size IS NOT NULL AND video_width IS NOT NULL
                    AND video_height IS NOT NULL AND video_duration_ms IS NOT NULL))
    END);
