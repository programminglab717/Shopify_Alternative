// What fails in the admin's browser, reported to the core (ADR-745), which logs it for the error
// tracker with its own errors: no DSN is in the browser, and the core's redaction is applied.
// What the API refused or could not be reached for is not reported: the core logs its own
// failures, and a network down is no fault of the admin's.

/** Where the core takes the admin's reports (apps/core/src/api/admin-errors.ts). */
export const ADMIN_ERRORS_PATH = '/admin/errors';

/** Reports a page sends at most, however long it is open: a fault in a loop is one fault. */
const PER_PAGE = 10;

/** What is sent of an error. */
export interface ErrorReport {
  type: string;
  message: string;
  stack?: string;
  page: string;
  release?: string;
}

/**
 * The page's path, its IDs taken out, so that the tracker groups one page's errors together and
 * no ID leaves: "/shops/0193…/orders/0193…" becomes "/shops/:id/orders/:id". Its query, which
 * may hold what was searched for, is never sent.
 */
export function pageOf(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => (/\d/.test(part) && part.length >= 6 ? ':id' : part))
    .join('/');
}

/** An error's report, or null for one not the admin's to report. */
export function reportOf(error: unknown, pathname: string, release?: string): ErrorReport | null {
  const page = pageOf(pathname);
  const base = release ? { page, release } : { page };
  if (error instanceof Error) {
    if (error.name === 'ApiError' || error.name === 'AbortError') return null;
    return {
      type: error.name || 'Error',
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
      ...base,
    };
  }
  const message = typeof error === 'string' ? error : safeString(error);
  return message ? { type: 'Error', message, ...base } : null;
}

function safeString(value: unknown): string {
  try {
    return value === undefined ? '' : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

export interface Reporter {
  /** Reports an error, once for each type and message, and at most ten a page. */
  report(error: unknown): void;
}

/** A reporter posting to the core through `send`, the browser's fetch unless told another. */
export function createReporter(options: {
  release?: string;
  pathname?: () => string;
  send?: (body: string) => Promise<unknown>;
}): Reporter {
  const send =
    options.send ??
    ((body: string) =>
      fetch(ADMIN_ERRORS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // Sent even as the page goes away.
        keepalive: true,
      }));
  const pathname = options.pathname ?? (() => window.location.pathname);
  const seen = new Set<string>();
  return {
    report(error) {
      if (seen.size >= PER_PAGE) return;
      const report = reportOf(error, pathname(), options.release);
      if (!report) return;
      const key = `${report.type}: ${report.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Reporting never fails the page, and never reports itself.
      send(JSON.stringify(report)).catch(() => undefined);
    },
  };
}

/** Reports what nothing in the page caught: errors thrown, and rejections nothing handled. */
export function reportUncaught(reporter: Reporter, target: Window = window): void {
  target.addEventListener('error', (event) => reporter.report(event.error ?? event.message));
  target.addEventListener('unhandledrejection', (event) => reporter.report(event.reason));
}
