import { toValue, type Emitter } from 'liquidjs';

/**
 * The most one render may do: a section, or the layout around them (04 §3.3). A section over any
 * limit renders as nothing and is logged; the rest of the page still renders.
 */
export interface RenderLimits {
  /** Wall-clock time, in milliseconds, data it waits for included. */
  timeMs: number;
  /**
   * Template nodes rendered: text, outputs and tags, counted as each renders, so a loop counts its
   * body once per pass. LiquidJS types a `templateLimit` like it but does not enforce it.
   */
  nodes: number;
  /** Characters of output. */
  output: number;
  /** LiquidJS's memory units: range items, and characters of strings some filters build. */
  memory: number;
  /** Snippets rendered inside snippets (`{% render %}`), as deep as they may go. */
  depth: number;
}

export const DEFAULT_LIMITS: RenderLimits = {
  timeMs: 150,
  nodes: 50_000,
  output: 2_000_000,
  memory: 5_000_000,
  depth: 32,
};

/** Which limit a render went over. */
export type LimitKind = 'time' | 'nodes' | 'output' | 'memory' | 'depth';

export class LimitError extends Error {
  constructor(readonly kind: LimitKind) {
    super(`over the ${kind} limit`);
    this.name = 'LimitError';
  }
}

/**
 * LiquidJS's render limiter, replaced: LiquidJS calls `check` before rendering each template node,
 * so it both counts nodes and watches a deadline. Partials share their caller's.
 */
export class WorkLimiter {
  nodes = 0;
  #depth = 0;
  readonly #deadline: number;

  constructor(private readonly limits: Pick<RenderLimits, 'timeMs' | 'nodes' | 'depth'>) {
    this.#deadline = performance.now() + limits.timeMs;
  }

  /** Into a snippet: refused past the depth limit, before recursion can run up the time. */
  enter(): void {
    this.#depth += 1;
    if (this.#depth > this.limits.depth) throw new LimitError('depth');
  }

  leave(): void {
    this.#depth -= 1;
  }

  check(now: number): void {
    this.nodes += 1;
    if (this.nodes > this.limits.nodes) throw new LimitError('nodes');
    if (now > this.#deadline) throw new LimitError('time');
  }

  /** LiquidJS's limiters also count use; time is not counted that way. */
  use(): void {}
}

/** Collects output as LiquidJS's own emitter does, up to `limit` characters. */
export class CappedEmitter implements Emitter {
  buffer = '';

  constructor(private readonly limit: number) {}

  write(html: unknown): void {
    const text = stringify(html);
    if (this.buffer.length + text.length > this.limit) throw new LimitError('output');
    this.buffer += text;
  }
}

/** The limit behind a render error, if one was: ours, or LiquidJS's memory limit. */
export function limitOf(error: unknown): LimitKind | null {
  for (let cause = error; cause instanceof Error;) {
    if (cause instanceof LimitError) return cause.kind;
    if (/memory alloc limit exceeded/.test(cause.message)) return 'memory';
    cause = (cause as { originalError?: unknown }).originalError;
  }
  return null;
}

/** As LiquidJS writes values: drops by their value, arrays joined, nothing for nil. */
function stringify(value: unknown): string {
  const plain: unknown = toValue(value);
  if (typeof plain === 'string') return plain;
  if (plain === null || plain === undefined) return '';
  if (Array.isArray(plain)) return plain.map(stringify).join('');
  return String(plain);
}
