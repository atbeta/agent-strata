export const NOTIFY_KEY = "strata.notify";

export type BusyRow = { id: string; title: string; busy: boolean };

export function readNotify(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveNotify(on: boolean) {
  localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
}

/** Sessions that were running and have now stopped. The first sight of a list never counts. */
export function finishedSessions(prev: ReadonlyMap<string, boolean>, next: readonly BusyRow[]): BusyRow[] {
  const done: BusyRow[] = [];
  for (const row of next) {
    if (prev.get(row.id) === true && !row.busy) done.push(row);
  }
  return done;
}

export function rememberBusy(prev: Map<string, boolean>, next: readonly BusyRow[]) {
  prev.clear();
  for (const row of next) prev.set(row.id, row.busy);
}

export async function enableNotify(): Promise<boolean> {
  saveNotify(true);
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export function disableNotify() {
  saveNotify(false);
}

/** A quiet chime plus a system notification, and only while this window is in the background. */
export function announceFinished(title: string) {
  if (!readNotify() || !document.hidden) return;
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title);
  }
  const Ctx = window.AudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 660;
  gain.gain.value = 0.04;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.08);
  osc.onended = () => void ctx.close();
}
