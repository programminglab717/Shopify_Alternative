import type { FbrEnvironment, FbrInvoiceRequest } from './fbr.js';

/** Where FBR's IMS takes invoices from POS, in each environment. */
export interface FbrPosOptions {
  /** https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData, unless a test says otherwise. */
  productionUrl: string;
  /** https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData, FBR's sandbox. */
  sandboxUrl: string;
  /** How long a request may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/** The shop's POS as the worker reports for it, its token opened. */
export interface FbrPosConnection {
  posId: number;
  accessToken: string;
  environment: FbrEnvironment;
  pctCode: string;
}

/** What FBR said: the number it gave the invoice, or why not, and whether to try again. */
export type FbrReportResult =
  { ok: true; invoiceNumber: string } | { ok: false; retry: boolean; message: string };

/** FBR's code for an invoice it took. */
const TAKEN = '100';

/**
 * Reports invoices to FBR's IMS as a POS does (POS-04, ADR-555): one request each, with the
 * access token FBR gave the shop's POS. FBR answers with the invoice's own number, which goes on
 * the printed invoice, or a code saying why it refused it.
 */
export class FbrPosClient {
  constructor(private readonly options: FbrPosOptions) {}

  async report(connection: FbrPosConnection, invoice: FbrInvoiceRequest): Promise<FbrReportResult> {
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
        body: JSON.stringify(invoice),
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
        message: `FBR refused the POS's access token (${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        retry: response.status >= 500 || response.status === 429,
        message: `FBR ${response.status}: ${text || 'no answer'}`.slice(0, 1_000),
      };
    }
    let answer: { InvoiceNumber?: unknown; Code?: unknown; Response?: unknown; Errors?: unknown };
    try {
      answer = JSON.parse(text) as typeof answer;
    } catch {
      return {
        ok: false,
        retry: true,
        message: `FBR answered what is not JSON: ${text}`.slice(0, 1_000),
      };
    }
    const code = String(answer.Code ?? '');
    const number = typeof answer.InvoiceNumber === 'string' ? answer.InvoiceNumber.trim() : '';
    if (code === TAKEN && number) return { ok: true, invoiceNumber: number };
    const why = [answer.Response, answer.Errors]
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(': ');
    const message = `FBR refused it (code ${code || 'none'}): ${why || 'no reason given'}`;
    return { ok: false, retry: false, message: message.slice(0, 1_000) };
  }
}
