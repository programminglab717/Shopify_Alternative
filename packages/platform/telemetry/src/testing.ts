import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type HistogramMetricData,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { METRIC_VIEWS } from './index.js';

/** A histogram's points as a test reads them: each point's attributes and counts by bucket. */
export interface HistogramPoint {
  attributes: Record<string, unknown>;
  count: number;
  /** How many values were at most each boundary, as Prometheus's `le` buckets count them. */
  atMost: Map<number, number>;
}

/**
 * Collects the metrics this process records from now on, for tests: the global meter provider is
 * replaced, so instruments made after this call are read by {@link CollectedMetrics.histogram}.
 * Call it before making what records them.
 */
export function collectMetrics(): CollectedMetrics {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  });
  metrics.disable();
  metrics.setGlobalMeterProvider(new MeterProvider({ views: METRIC_VIEWS, readers: [reader] }));
  const named = async (name: string): Promise<MetricData[]> => {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === name);
  };
  return {
    async counter(name) {
      return (await named(name)).flatMap((metric) =>
        metric.dataPoints.map((point) => ({
          attributes: { ...point.attributes },
          value: point.value as number,
        })),
      );
    },
    async histogram(name) {
      const found = (await named(name)) as HistogramMetricData[];
      return found.flatMap((metric) =>
        metric.dataPoints.map((point) => {
          const { boundaries, counts } = point.value.buckets;
          const atMost = new Map<number, number>();
          let sum = 0;
          boundaries.forEach((boundary, i) => {
            sum += counts[i] ?? 0;
            atMost.set(boundary, sum);
          });
          return { attributes: { ...point.attributes }, count: point.value.count, atMost };
        }),
      );
    },
  };
}

export interface CollectedMetrics {
  /** The points of the counter `name` counted so far. */
  counter(name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]>;
  /** The points of the histogram `name` recorded so far. */
  histogram(name: string): Promise<HistogramPoint[]>;
}
