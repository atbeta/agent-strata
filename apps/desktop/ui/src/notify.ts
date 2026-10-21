import { t } from "./i18n";

export const NOTIFY_KEY = "strata.notify";

export type BusyRow = { id: string; title: string; busy: boolean; needsInput?: boolean };
export type NoticeRow = BusyRow;

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

/**
 * Sessions that have just started waiting for a person.
 *
 * A permission or a question is the one state where the agent cannot proceed
 * without the reader, and it is the state a background window used to show
 * nothing about. Only the transition counts: a session that was already waiting
 * when the list first loaded must not produce a notification for a request the
 * reader has already seen.
 */
export function waitingSessions(
  prev: ReadonlyMap<string, boolean>,
  next: readonly NoticeRow[],
): NoticeRow[] {
  const waiting: NoticeRow[] = [];
  for (const row of next) {
    if (row.needsInput === true && prev.get(row.id) !== true) waiting.push(row);
  }
  return waiting;
}

export function rememberWaiting(prev: Map<string, boolean>, next: readonly NoticeRow[]) {
  prev.clear();
  for (const row of next) prev.set(row.id, row.needsInput === true);
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

/** A quiet chime, and only while this window is in the background. */
function chime() {
  if (!readNotify() || !document.hidden) return;
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

/** Bring the window forward and land on the session a notice is about. */
function focusSession(sessionId: string | undefined) {
  window.focus();
  if (sessionId) location.hash = `/session/${encodeURIComponent(sessionId)}`;
}

function systemNotification(title: string, body: string | undefined, sessionId: string | undefined) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const notice = new Notification(title, {
    ...(body ? { body } : {}),
    ...(sessionId ? { tag: sessionId } : {}),
  });
  notice.onclick = () => {
    focusSession(sessionId);
    notice.close();
  };
}

/** A quiet chime plus a system notification, and only while this window is in the background. */
export function announceFinished(title: string, sessionId?: string) {
  if (!readNotify() || !document.hidden) return;
  systemNotification(title, undefined, sessionId);
  chime();
}

/** The same, for a session that has stopped and is waiting on the reader. */
export function announceNeedsInput(title: string, sessionId?: string) {
  if (!readNotify() || !document.hidden) return;
  systemNotification(t("notify.needsInput"), title, sessionId);
  chime();
}
