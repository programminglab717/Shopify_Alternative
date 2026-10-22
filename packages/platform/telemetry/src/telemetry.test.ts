import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { METRIC_VIEWS, shutdownTelemetry, startTelemetry } from './index.js';

describe('startTelemetry', () => {
  it('stays off without a collector endpoint', async () => {
    const telemetry = startTelemetry({ serviceName: 'test', env: {} });
    expect(telemetry.enabled).toBe(false);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('can be switched off explicitly', () => {
    const telemetry = startTelemetry({
      serviceName: 'test',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_SDK_DISABLED: 'true' },
    });
    expect(telemetry.enabled).toBe(false);
  });

  it('starts once with an endpoint and shuts down cleanly', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', NODE_ENV: 'test' };
    const telemetry = startTelemetry({ serviceName: 'test', env });
    expect(telemetry.enabled).toBe(true);
    expect(startTelemetry({ serviceName: 'other', env })).toBe(telemetry);
    await shutdownTelemetry();
  });
});

describe('Metric views (ADR-726)', () => {
  it("counts HTTP requests within 800 ms, checkout's objective, in a bucket of their own", async () => {
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({ views: METRIC_VIEWS, readers: [reader] });
    const meter = provider.getMeter('test');
    const server = meter.createHistogram('http.server.request.duration', { unit: 's' });
    const other = meter.createHistogram('hatti.other.duration', { unit: 's' });
    for (const seconds of [0.3, 0.78, 0.79, 0.85]) server.record(seconds);
    other.record(0.79);
    const { resourceMetrics } = await reader.collect();
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    const histogram = (name: string) =>
      metrics.find((metric) => metric.descriptor.name === name) as HistogramMetricData;
    const { buckets } = histogram('http.server.request.duration').dataPoints[0]!.value;
    const at = buckets.boundaries.indexOf(0.8);
    expect(at).toBeGreaterThan(0);
    expect(buckets.boundaries[at - 1]).toBe(0.75);
    // Requests within 800 ms are those up to the 0.8 boundary: three of the four.
    const within = buckets.counts.slice(0, at + 1).reduce((sum, count) => sum + count, 0);
    expect(within).toBe(3);
    // Other histograms keep OpenTelemetry's buckets.
    expect(histogram('hatti.other.duration').dataPoints[0]!.value.buckets.boundaries).not.toContain(
      0.8,
    );
    await provider.shutdown();
  });
});
