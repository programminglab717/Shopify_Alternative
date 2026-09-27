// Loaded with `node --import ./dist/instrumentation.js` before the application, so
// instrumentation is in place before the libraries it patches are loaded. Does nothing unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { basename } from 'node:path';
import { startTelemetry } from '@hatti/telemetry';

const SERVICE_NAMES: Readonly<Record<string, string>> = {
  main: 'core-api',
  worker: 'core-worker',
  seed: 'core-seed',
};

const entry = basename(process.argv[1] ?? 'core', '.js');
startTelemetry({ serviceName: SERVICE_NAMES[entry] ?? `core-${entry}` });
