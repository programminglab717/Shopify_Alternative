-- 0161 · Products' videos
-- A product's media may be a video the shop uploaded, MP4 or QuickTime as phones record it, which
-- Hatti keeps and serves as it is but for what the phone wrote of where it was taken; or a YouTube
-- or Vimeo video, by its address. Each shows an image before it plays, its preview, kept as a
-- product's image is (CAT-02). See ADR-258 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.product_media
  DROP CONSTRAINT product_media_media_type_check,
  ADD CONSTRAINT product_media_media_type_check
    CHECK (media_type IN ('image', 'video', 'external_video')),
  -- Where a video's preview image comes from: an image's URL, or a file the shop uploaded, by its
  -- location and key. Null for an image, whose own source is its image, and for a YouTube or
  -- Vimeo video whose own is taken.
  ADD COLUMN preview_source_url text
    CHECK (preview_source_url ~ '^https?://' AND length(preview_source_url) <= 2048),
  ADD COLUMN preview_source_key text,
  ADD CONSTRAINT product_media_preview_key_check
    CHECK (preview_source_key IS NULL
           OR (preview_source_key LIKE 'shops/' || shop_id || '/%'
               AND preview_source_url IS NOT NULL)),
  -- A YouTube or Vimeo video: which, and its ID there.
  ADD COLUMN video_host text CHECK (video_host IN ('youtube', 'vimeo')),
  ADD COLUMN video_external_id text CHECK (video_external_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- A video the shop uploaded, once ready: its clean copy's bytes, its frame as shown, in pixels,
  -- and how long it lasts.
  ADD COLUMN video_size integer CHECK (video_size > 0),
  ADD COLUMN video_width integer CHECK (video_width > 0),
  ADD COLUMN video_height integer CHECK (video_height > 0),
  ADD COLUMN video_duration_ms integer CHECK (video_duration_ms > 0),
  -- What each kind has: an image nothing of a video's; a YouTube or Vimeo video its host and ID;
  -- an uploaded video its file and preview's sources, and its own facts once ready. Only an image
  -- is cropped.
  ADD CONSTRAINT product_media_kind_check CHECK (
    CASE media_type
      WHEN 'image' THEN preview_source_url IS NULL AND video_host IS NULL AND video_size IS NULL
      WHEN 'external_video' THEN video_host IS NOT NULL AND video_external_id IS NOT NULL
                                 AND video_size IS NULL AND crop_left IS NULL
      ELSE source_key IS NOT NULL AND preview_source_url IS NOT NULL AND video_host IS NULL
           AND crop_left IS NULL
           AND (status <> 'ready'
                OR (video_size IS NOT NULL AND video_width IS NOT NULL
                    AND video_height IS NOT NULL AND video_duration_ms IS NOT NULL))
    END);

-- Files may be videos, up to 100 MiB.
ALTER TABLE files.files
  DROP CONSTRAINT files_content_type_check,
  ADD CONSTRAINT files_content_type_check
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif',
                            'application/pdf', 'video/mp4', 'video/quicktime')),
  DROP CONSTRAINT files_size_check,
  ADD CONSTRAINT files_size_check
    CHECK (size BETWEEN 1 AND CASE WHEN content_type LIKE 'video/%' THEN 104857600
                                   ELSE 20971520 END);
