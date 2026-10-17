import type { GoogleEventsPayload } from './google.js';

/** Where Google Analytics takes events from servers. */
export interface GoogleAnalyticsOptions {
  /** https://www.google-analytics.com, unless a test says otherwise. */
  baseUrl: string;
  /** How long a request may take; ten seconds unless given. */
  timeoutMs?: number;
}

/** The data stream events go to, as the shop connected it. */
export interface GoogleStream {
  measurementId: string;
  apiSecret: string;
}

/** What Google said of the requests: it took the events, or why not, and whether to try again. */
export type GoogleSendResult = { ok: true } | { ok: false; retry: boolean; message: string };

/**
 * Sends events to a web data stream through Google Analytics' Measurement Protocol (ADR-547).
 * Google answers every well-formed request alike, and says nothing of an event it drops.
 */
export class GoogleAnalyticsClient {
  constructor(private readonly options: GoogleAnalyticsOptions) {}

  /**
   * Sends each payload in a request of its own, as each is one browser's, stopping at the first
   * Google refuses. The secret goes in the address, as the protocol asks: nothing logs it.
   */
  async send(
    stream: GoogleStream,
    payloads: readonly GoogleEventsPayload[],
  ): Promise<GoogleSendResult> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const query = new URLSearchParams({
      measurement_id: stream.measurementId,
      api_secret: stream.apiSecret,
    });
    for (const payload of payloads) {
      let response: Response;
      try {
        response = await fetch(`${base}/mp/collect?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
      } catch (error) {
        return {
          ok: false,
          retry: true,
          message: `Google could not be reached: ${(error as Error).message}`,
        };
      }
      if (response.ok) continue;
      const text = (await response.text().catch(() => '')).trim();
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `Google ${response.status}: ${text || 'no answer'}`.slice(0, 1_000),
      };
    }
    return { ok: true };
  }
}
