import type { MetaServerEvent } from './meta.js';

/** Where Meta's Graph API is, and which version events go to. */
export interface MetaGraphOptions {
  /** https://graph.facebook.com, unless a test says otherwise. */
  baseUrl: string;
  /** "v26.0". */
  version: string;
  /** How long a request may take; ten seconds unless given. */
  timeoutMs?: number;
}

/** The dataset events go to, as the shop connected it. */
export interface MetaDataset {
  pixelId: string;
  accessToken: string;
  testEventCode: string | null;
}

/** What Meta said of a request: it took the events, or why not, and whether to try again. */
export type MetaSendResult =
  | { ok: true; eventsReceived: number; traceId: string | null }
  | { ok: false; retry: boolean; message: string; traceId: string | null };

/**
 * Graph API errors that pass: Meta busy, or the shop's calls over their limits for now
 * (https://developers.facebook.com/docs/graph-api/guides/error-handling).
 */
const PASSING = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * Errors of the shop's connection, which it can put right: a token that expired or was revoked,
 * or one without the dataset's permission. Its events wait for it while they can still go.
 */
const CONNECTION = new Set([10, 102, 190]);

/** The Graph API error a request was refused with. */
interface GraphError {
  message?: string;
  code?: number;
  is_transient?: boolean;
  error_user_msg?: string;
  fbtrace_id?: string;
}

/** Sends server events to a dataset through Meta's conversions API (ADR-143). */
export class MetaConversionsClient {
  constructor(private readonly options: MetaGraphOptions) {}

  /**
   * Sends `events` in one request, at most a thousand. The token goes in the request's body, so
   * that no log of addresses keeps it.
   */
  async send(dataset: MetaDataset, events: readonly MetaServerEvent[]): Promise<MetaSendResult> {
    const body = new URLSearchParams({
      data: JSON.stringify(events),
      access_token: dataset.accessToken,
    });
    if (dataset.testEventCode) body.set('test_event_code', dataset.testEventCode);
    const base = this.options.baseUrl.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(
        `${base}/${this.options.version}/${encodeURIComponent(dataset.pixelId)}/events`,
        { method: 'POST', body, signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) },
      );
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `Meta could not be reached: ${(error as Error).message}`,
        traceId: null,
      };
    }
    const json = (await response.json().catch(() => null)) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: GraphError;
    } | null;
    if (response.ok) {
      return {
        ok: true,
        eventsReceived: Number(json?.events_received ?? 0),
        traceId: json?.fbtrace_id ?? null,
      };
    }
    const error = json?.error ?? {};
    const code = error.code ?? 0;
    return {
      ok: false,
      retry:
        response.status >= 500 ||
        response.status === 429 ||
        error.is_transient === true ||
        PASSING.has(code) ||
        CONNECTION.has(code) ||
        (code >= 200 && code <= 299),
      message: (error.error_user_msg || error.message || `Meta answered ${response.status}`).slice(
        0,
        1_000,
      ),
      traceId: error.fbtrace_id ?? null,
    };
  }
}
