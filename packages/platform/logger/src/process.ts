import type { Logger } from 'pino';
import { ErrorTracker } from './error-tracking.js';

/** What a process's error tracker is configured by (ADR-743): its config, or its environment. */
export interface ErrorTrackingConfig {
  NODE_ENV?: string;
  ERROR_TRACKING_DSN?: string;
  ERROR_TRACKING_ENVIRONMENT?: string;
  ERROR_TRACKING_RELEASE?: string;
}

/** The error tracker errors logged go to as well, once a DSN is set; none without one. */
export function errorTrackerOf(config: ErrorTrackingConfig): ErrorTracker | undefined {
  if (!config.ERROR_TRACKING_DSN) return undefined;
  return new ErrorTracker({
    dsn: config.ERROR_TRACKING_DSN,
    environment: config.ERROR_TRACKING_ENVIRONMENT || config.NODE_ENV || 'development',
    release: config.ERROR_TRACKING_RELEASE || undefined,
  });
}

/**
 * Logs an exception nothing caught, or a rejection nothing handled, as fatal, so that it reaches
 * the error tracker too, then lets the last events go before the process exits, as Node would.
 */
export function logUncaught(logger: Logger, tracker: ErrorTracker | undefined): void {
  const fatal = (error: unknown, kind: string) => {
    logger.fatal({ err: error }, kind);
    void (tracker?.flush() ?? Promise.resolve()).finally(() => process.exit(1));
  };
  process.on('uncaughtException', (error) => fatal(error, 'uncaught exception'));
  process.on('unhandledRejection', (reason) => fatal(reason, 'unhandled rejection'));
}
