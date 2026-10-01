/**
 * Runs `task` now, then every `intervalMs` after the last run ends, so runs never overlap: the
 * worker's sweeps. A failed run is `onError`'s, and the next one comes as usual.
 */
export function repeat(
  task: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): { stop(): Promise<void> } {
  let running: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    running = task().catch(onError);
    return running;
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void tick().then(schedule), intervalMs);
  };
  void tick().then(schedule);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
