import type { FbrReportResult } from './fbr-client.js';
import { DI_VALID, diInvoiceRequest, type DiInvoiceBody } from './fbr-di.js';
import type { FbrEnvironment } from './fbr.js';

/** Where FBR's digital invoicing takes invoices, in each environment. */
export interface FbrDigitalInvoicingOptions {
  /** FBR_DI_URLS.production, unless a test says otherwise. */
  productionUrl: string;
  /** FBR_DI_URLS.sandbox, FBR's sandbox. */
  sandboxUrl: string;
  /** How long a request may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/** The shop's connection to digital invoicing as the worker reports for it, its token opened. */
export interface FbrDigitalInvoicingConnection {
  /** The security token FBR issued the seller through IRIS. */
  accessToken: string;
  environment: FbrEnvironment;
  pctCode: string;
}

/** What digital invoicing answers, as much of it as is read. */
interface DiAnswer {
  invoiceNumber?: unknown;
  validationResponse?: {
    statusCode?: unknown;
    errorCode?: unknown;
    error?: unknown;
    invoiceStatuses?: unknown;
  } | null;
}

interface DiItemStatus {
  itemSNo?: unknown;
  statusCode?: unknown;
  errorCode?: unknown;
  error?: unknown;
}

/** A value FBR gave as text, trimmed; blank for none. */
function textOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/**
 * Reports invoices to FBR's digital invoicing (TAX-04, ADR-562): one request each, with the
 * security token FBR issued the seller. FBR answers with the invoice's own number, which goes on
 * the printed invoice, once it found the invoice and each of its items valid, or says what of it
 * is not.
 */
export class FbrDigitalInvoicingClient {
  constructor(private readonly options: FbrDigitalInvoicingOptions) {}

  async report(
    connection: FbrDigitalInvoicingConnection,
    body: DiInvoiceBody,
  ): Promise<FbrReportResult> {
    const url =
      connection.environment === 'production'
        ? this.options.productionUrl
        : this.options.sandboxUrl;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${connection.accessToken}`,
        },
        body: JSON.stringify(diInvoiceRequest(body, connection.environment, connection.pctCode)),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `FBR could not be reached: ${(error as Error).message}`,
      };
    }
    const text = (await response.text().catch(() => '')).trim();
    if (response.status === 401 || response.status === 403) {
      // Tried again: the shop may put a new token in.
      return {
        ok: false,
        retry: true,
        message: `FBR refused the seller's token (${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `FBR ${response.status}: ${text || 'no answer'}`.slice(0, 1_000),
      };
    }
    let answer: DiAnswer;
    try {
      answer = JSON.parse(text) as DiAnswer;
      if (answer === null || typeof answer !== 'object') throw new Error('not an object');
    } catch {
      return {
        ok: false,
        retry: true,
        message: `FBR answered what is not JSON: ${text}`.slice(0, 1_000),
      };
    }
    const validation = answer.validationResponse ?? {};
    const code = textOf(validation.statusCode);
    const items = (
      Array.isArray(validation.invoiceStatuses) ? validation.invoiceStatuses : []
    ) as DiItemStatus[];
    const invalid = items.filter((item) => textOf(item?.statusCode) !== DI_VALID);
    const number = textOf(answer.invoiceNumber);
    // Taken only when the invoice and every item of it are valid, and FBR numbered it.
    if (code === DI_VALID && invalid.length === 0 && number) {
      return { ok: true, invoiceNumber: number };
    }
    const why = [
      [textOf(validation.error), textOf(validation.errorCode)] as const,
      ...invalid.map(
        (item) =>
          [
            `item ${textOf(item?.itemSNo) || '?'}: ${textOf(item?.error) || 'invalid'}`,
            textOf(item?.errorCode),
          ] as const,
      ),
    ]
      .filter(([error, errorCode]) => error || errorCode)
      .map(([error, errorCode]) => (errorCode ? `${error || 'invalid'} (${errorCode})` : error))
      .join('; ');
    const message = `FBR refused it (code ${code || 'none'}): ${why || 'no reason given'}`;
    return { ok: false, retry: false, message: message.slice(0, 1_000) };
  }
}
