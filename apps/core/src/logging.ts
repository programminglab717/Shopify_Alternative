import type { Logger } from '@hatti/logger';
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
