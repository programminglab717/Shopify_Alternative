// Loaded with `node --import ./dist/cli/instrumentation.js` before the server, so instrumentation
// is in place before the libraries it patches are loaded (ADR-726). Does nothing unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { startTelemetry } from '@hatti/telemetry';

startTelemetry({ serviceName: 'storefront' });
