import type { TikTokEvent } from './tiktok.js';

/** Where TikTok's Business API is. */
export interface TikTokApiOptions {
  /** https://business-api.tiktok.com, unless a test says otherwise. */
  baseUrl: string;
  /** How long a request may take; ten seconds unless given. */
  timeoutMs?: number;
}

/** The pixel events go to, as the shop connected it. */
export interface TikTokPixel {
  pixelCode: string;
  accessToken: string;
  testEventCode: string | null;
}

/** What TikTok said of a request: it took the events, or why not, and whether to try again. */
export type TikTokSendResult =
  | { ok: true; requestId: string | null }
  | { ok: false; retry: boolean; message: string; requestId: string | null };

/**
 * TikTok's codes that pass, or that the shop can put right: its calls over their limits for now,
 * TikTok's own trouble, and a token that expired, was revoked or lacks the pixel's permission. Its
 * events wait while they can still go.
 */
const RETRYING = new Set([40100, 40102, 40104, 40105, 40106, 50000, 50002, 51021]);

/** Sends web events to a pixel through TikTok's Events API (ADR-541). */
export class TikTokEventsClient {
  constructor(private readonly options: TikTokApiOptions) {}

  /**
   * Sends `events` in one request, at most a thousand. The token goes in a header, so that no log
   * of addresses keeps it.
   */
  async send(pixel: TikTokPixel, events: readonly TikTokEvent[]): Promise<TikTokSendResult> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/open_api/v1.3/event/track/`, {
        method: 'POST',
        headers: { 'access-token': pixel.accessToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: pixel.pixelCode,
          ...(pixel.testEventCode && { test_event_code: pixel.testEventCode }),
          data: events,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `TikTok could not be reached: ${(error as Error).message}`,
        requestId: null,
      };
    }
    const json = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      request_id?: string;
    } | null;
    const code = json?.code;
    const requestId = json?.request_id ?? null;
    if (response.ok && code === 0) return { ok: true, requestId };
    return {
      ok: false,
      retry:
        response.status >= 500 ||
        response.status === 429 ||
        (code !== undefined && RETRYING.has(code)),
      message: `TikTok ${code ?? response.status}: ${json?.message ?? 'no answer'}`.slice(0, 1_000),
      requestId,
    };
  }
}
