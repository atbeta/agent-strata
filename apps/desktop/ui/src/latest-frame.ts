export function createLatestFrame<T>(intervalMs: number, paint: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: T | undefined;
  let lastPaint = 0;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (latest === undefined) return;
    const value = latest;
    latest = undefined;
    lastPaint = Date.now();
    paint(value);
  };

  return {
    schedule(value: T) {
      latest = value;
      if (lastPaint === 0) {
        flush();
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(flush, Math.max(0, intervalMs - (Date.now() - lastPaint)));
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}
