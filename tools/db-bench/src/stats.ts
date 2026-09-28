export interface LatencySummary {
  count: number;
  /** Operations per second over the measured window. */
  throughput: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Summarises latencies in milliseconds measured over `seconds`. */
export function summarize(latenciesMs: number[], seconds: number): LatencySummary {
  const sorted = Float64Array.from(latenciesMs).sort();
  const at = (q: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const total = latenciesMs.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    throughput: sorted.length / seconds,
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
}

export const ms = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

export const perSecond = (value: number): string => Math.round(value).toLocaleString('en');

export const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** A GitHub-flavoured Markdown table. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}
