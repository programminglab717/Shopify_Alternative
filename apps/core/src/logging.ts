import { ErrorTracker, type Logger } from '@hatti/logger';
import type { LoggerService } from '@nestjs/common';

/** Routes NestJS framework logs into our structured logger. */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(this.fields(params), String(message));
  }

  error(message: unknown, ...params: unknown[]): void {
    // Nest passes (message, stack?, context?).
    const [stack, ...rest] = params;
    this.logger.error(
      { ...this.fields(rest), ...(typeof stack === 'string' ? { stack } : {}) },
      String(message),
    );
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(this.fields(params), String(message));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(this.fields(params), String(message));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.trace(this.fields(params), String(message));
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.logger.fatal(this.fields(params), String(message));
  }

  private fields(params: unknown[]): Record<string, unknown> {
    const context = params.at(-1);
    return typeof context === 'string' ? { context } : {};
  }
}

/** What the error tracker is configured by (ADR-743). */
interface ErrorTrackingConfig {
  NODE_ENV: string;
  ERROR_TRACKING_DSN?: string;
  ERROR_TRACKING_ENVIRONMENT?: string;
  ERROR_TRACKING_RELEASE?: string;
}

/** The error tracker errors logged go to as well, once a DSN is set; none without one. */
export function errorTrackerOf(config: ErrorTrackingConfig): ErrorTracker | undefined {
  if (!config.ERROR_TRACKING_DSN) return undefined;
  return new ErrorTracker({
    dsn: config.ERROR_TRACKING_DSN,
    environment: config.ERROR_TRACKING_ENVIRONMENT ?? config.NODE_ENV,
    release: config.ERROR_TRACKING_RELEASE,
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
