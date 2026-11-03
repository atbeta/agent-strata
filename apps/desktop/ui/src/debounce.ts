import { onCleanup } from "solid-js";

export function createDebouncer(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(cancel);

  return {
    schedule(task: () => void) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        task();
      }, delayMs);
    },
    cancel,
  };
}
