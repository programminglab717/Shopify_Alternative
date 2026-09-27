import type { IncomingMessage } from 'node:http';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  /** Default service name; OTEL_SERVICE_NAME overrides it. */
  serviceName: string;
  serviceVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Telemetry {
  readonly enabled: boolean;
  /** Flushes buffered spans and metrics. Call before the process exits. */
  shutdown(): Promise<void>;
}

const disabled: Telemetry = { enabled: false, shutdown: async () => {} };
let current: Telemetry = disabled;

/** Probes run every few seconds; tracing them would drown real traffic. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz']);

function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/**
 * Starts OpenTelemetry traces and metrics, exported over OTLP/HTTP to the collector named by the
 * standard OTEL_EXPORTER_OTLP_ENDPOINT variable. Without it, or with OTEL_SDK_DISABLED=true,
 * nothing starts and every span and metric call is a cheap no-op.
 *
 * Must run before the instrumented libraries load: entry points pass it with `node --import`.
 *
 * Personal data stays out of telemetry: SQL is recorded without parameter values, Redis commands
 * without keys or arguments, and GraphQL without variable values.
 */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (current.enabled || env.OTEL_SDK_DISABLED === 'true' || !endpoint) return current;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
      'service.namespace': 'hatti',
      'deployment.environment.name': env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request: IncomingMessage) =>
          UNTRACED_PATHS.has(pathOf(request.url)),
      }),
      new UndiciInstrumentation(),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        // One span per request and handler. Hook spans would mostly be framework internals.
        instrumentHooks: false,
        ignorePaths: (route: { url: string }) => UNTRACED_PATHS.has(route.url),
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
      new IORedisInstrumentation({
        requireParentSpan: true,
        dbStatementSerializer: (command: string) => command,
      }),
      new GraphQLInstrumentation({
        mergeItems: true,
        ignoreTrivialResolveSpans: true,
        allowValues: false,
      }),
    ],
  });
  sdk.start();
  current = { enabled: true, shutdown: () => sdk.shutdown() };
  return current;
}

/** Flushes and stops telemetry if it was started; otherwise does nothing. */
export function shutdownTelemetry(): Promise<void> {
  return current.shutdown();
}
