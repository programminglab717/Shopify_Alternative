import type { Logger } from '@hatti/logger';
import { shutdownTelemetry } from '@hatti/telemetry';

/**
 * Runs `close` once on SIGTERM or SIGINT, then exits. Kubernetes sends SIGTERM and waits for the
 * grace period, so in-flight work gets to finish; a second signal exits immediately.
 */
export function onShutdown(logger: Logger, close: () => Promise<void>): void {
  let closing = false;
  const handler = (signal: NodeJS.Signals) => {
    if (closing) process.exit(1);
    closing = true;
    logger.info({ signal }, 'shutting down');
    close()
      // Flush the last spans and metrics, or they are lost with the process.
      .then(() => shutdownTelemetry())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
