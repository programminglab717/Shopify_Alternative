import { imagesPrefixOf } from './images.js';
import type { MediaRecord } from './records.js';

// Products' videos (ADR-258): one the shop uploaded, which the core serves as it is but for what a
// phone wrote of where it was taken, from its media's folder in storage; or a YouTube or Vimeo
// video, by its host and ID there, which pages embed from its host.

/** Where the core serves the videos shops uploaded. */
export const VIDEOS_PATH = '/videos';

export type VideoHostValue = 'youtube' | 'vimeo';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VIDEO_PATH = new RegExp(`^${VIDEOS_PATH}/(${UUID})/(${UUID})/[a-z0-9-]{1,100}\\.mp4$`);

/**
 * A YouTube or Vimeo video, from its address as people copy it: a watch page, a short, a share
 * link or a player's; null for any other.
 */
export function externalVideoOf(address: string): { host: VideoHostValue; id: string } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id =
      host === 'youtu.be'
        ? path[0]
        : path[0] === 'watch'
          ? url.searchParams.get('v')
          : ['embed', 'shorts', 'live', 'v'].includes(path[0] ?? '')
            ? path[1]
            : null;
    return id && YOUTUBE_ID.test(id) ? { host: 'youtube', id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = host === 'vimeo.com' ? path.find((part) => VIMEO_ID.test(part)) : path[1];
    return (host === 'vimeo.com' || path[0] === 'video') && id && VIMEO_ID.test(id)
      ? { host: 'vimeo', id }
      : null;
  }
  return null;
}

/** Where a YouTube or Vimeo video is watched, and where pages embed it from. */
export function externalVideoUrls(
  host: VideoHostValue,
  id: string,
): { originUrl: string; embedUrl: string } {
  return host === 'youtube'
    ? {
        originUrl: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}`,
      }
    : { originUrl: `https://vimeo.com/${id}`, embedUrl: `https://player.vimeo.com/video/${id}` };
}

/**
 * The images a YouTube video's host shows for it, the largest first, which only HD videos have;
 * none for Vimeo, which says its own when asked.
 */
export function hostPreviewsOf(host: VideoHostValue, id: string): string[] {
  return host === 'youtube'
    ? [
        `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      ]
    : [];
}

/** Where Vimeo says what image a video of its shows. */
export function vimeoOembedUrl(id: string): string {
  return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}&width=1280`;
}

/** Where storage keeps a video the shop uploaded, once ready: in its media's folder. */
export function videoKeyOf(shopId: string, mediaId: string): string {
  return `${imagesPrefixOf(shopId, mediaId)}video.mp4`;
}

/**
 * The path a video the shop uploaded is served at once ready, named after its product's handle:
 * /videos/{shop}/{media}/lawn-suit.mp4. Null for anything else.
 */
export function videoPathOf(
  shopId: string,
  media: Pick<MediaRecord, 'id' | 'mediaType' | 'video'>,
  handle: string,
): string | null {
  if (media.mediaType !== 'video' || media.video === null) return null;
  return `${VIDEOS_PATH}/${shopId}/${media.id}/${handle || 'video'}.mp4`;
}

/** The shop and media `path` names, if it is a video's path. */
export function parseVideoPath(path: string): { shopId: string; mediaId: string } | null {
  const match = VIDEO_PATH.exec(path);
  return match ? { shopId: match[1]!, mediaId: match[2]! } : null;
}
