/**
 * A page's HTML as its renders write it, read as it comes by one reader: each read gives what was
 * written since the last, joined, and waits when nothing was.
 */
export class ChunkQueue implements AsyncIterable<string> {
  #chunks: string[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  push(chunk: string): void {
    if (this.#closed || chunk === '') return;
    this.#chunks.push(chunk);
    this.#notify();
  }

  /** No more is coming: the reader ends once it has read what was written. */
  close(): void {
    this.#closed = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.#chunks.length > 0) yield this.#chunks.splice(0).join('');
      else if (this.#closed) return;
      else await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
