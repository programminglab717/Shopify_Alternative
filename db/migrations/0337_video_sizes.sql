-- 0337 · Smaller sizes of products' videos
-- The worker makes 720p and 480p copies of each video a shop uploads (CAT-02, ADR-791), by short
-- side, beside the original in its media's folder, which pages offer to smaller screens. A video
-- is due for them once ready (video_sizes_at), and keeps what was made (video_sizes): null until
-- tried, an empty list where none was worth making or ffmpeg could not make them. Videos ready
-- before are due now.

ALTER TABLE catalog.product_media
  ADD COLUMN video_sizes jsonb CHECK (video_sizes IS NULL OR jsonb_typeof(video_sizes) = 'array'),
  ADD COLUMN video_sizes_at timestamptz;

UPDATE catalog.product_media SET video_sizes_at = now()
 WHERE status = 'ready' AND video_size IS NOT NULL;

CREATE INDEX product_media_video_sizes_due
  ON catalog.product_media (video_sizes_at) WHERE video_sizes_at IS NOT NULL;
