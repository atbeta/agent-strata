import { t } from "./i18n";
import { inDesktopShell } from "./shell";

export const NOTIFY_DONE_KEY = "strata.notify.done";
export const NOTIFY_QUESTION_KEY = "strata.notify.question";

/** A finished turn and a request for a person are separate preferences:
 *  plenty of readers want the tap on the shoulder without the chime on every
 *  completed turn, or the reverse. */
export type NotifyKind = "done" | "question";

/** Both kinds shared this key before they split; its value seeds whichever
 *  row has not been saved yet. */
const NOTIFY_LEGACY_KEY = "strata.notify";

const NOTIFY_KEYS: Record<NotifyKind, string> = {
  done: NOTIFY_DONE_KEY,
  question: NOTIFY_QUESTION_KEY,
};

type NotifyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Copy the shared key into any kind still unset, then drop it. */
function migrateNotify(storage: NotifyStorage) {
  const legacy = storage.getItem(NOTIFY_LEGACY_KEY);
  if (legacy === null) return;
  for (const key of Object.values(NOTIFY_KEYS)) {
    if (storage.getItem(key) === null) storage.setItem(key, legacy);
  }
  storage.removeItem(NOTIFY_LEGACY_KEY);
}

export function readNotify(kind: NotifyKind, storage: NotifyStorage = localStorage): boolean {
  try {
    migrateNotify(storage);
    return storage.getItem(NOTIFY_KEYS[kind]) === "1";
  } catch {
    return false;
  }
}

export function saveNotify(kind: NotifyKind, on: boolean, storage: NotifyStorage = localStorage) {
  // Saving one kind must not strand the other on the legacy value, so the
  // copy happens before the write rather than only on read.
  migrateNotify(storage);
  storage.setItem(NOTIFY_KEYS[kind], on ? "1" : "0");
}

export type BusyRow = { id: string; title: string; busy: boolean; needsInput?: boolean };

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
  next: readonly BusyRow[],
): BusyRow[] {
  const waiting: BusyRow[] = [];
  for (const row of next) {
    if (row.needsInput === true && prev.get(row.id) !== true) waiting.push(row);
  }
  return waiting;
}

export function rememberWaiting(prev: Map<string, boolean>, next: readonly BusyRow[]) {
  prev.clear();
  for (const row of next) prev.set(row.id, row.needsInput === true);
}

let actionsInstalled = false;
let actionsInstalling: Promise<void> | undefined;

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * The plugin's JS `isPermissionGranted` short-circuits on WebKit's
 * `Notification.permission`, which can say "granted" even when the native
 * plugin was never injected. Calling the command itself is the only way to
 * know that the shell side exists.
 */
async function desktopPermission(): Promise<boolean> {
  return desktopInvoke<boolean>("plugin:notification|is_permission_granted");
}

async function requestDesktopPermission(): Promise<boolean> {
  const state = await desktopInvoke<string>("plugin:notification|request_permission");
  return state === "granted";
}

async function sendDesktop(
  title: string,
  body: string | undefined,
  sessionId: string | undefined,
): Promise<void> {
  if (!(await desktopPermission())) throw new Error(t("settings.notify.blocked"));
  await desktopInvoke("plugin:notification|notify", {
    options: {
      title,
      ...(body ? { body } : {}),
      ...(sessionId ? { group: sessionId, extra: { sessionId } } : {}),
      autoCancel: true,
    },
  });
}

/**
 * Register the desktop click handler once. The native notification carries the
 * session id in `extra`; a click is reported as the `tap` action, which is how
 * a background notice returns to the conversation that produced it.
 */
export function installNotifyActions(): Promise<void> {
  if (!inDesktopShell()) return Promise.resolve();
  if (actionsInstalled) return Promise.resolve();
  actionsInstalling ??= (async () => {
    const mod = await import("@tauri-apps/plugin-notification");
    // A preference saved by the old web-notification path can say "on" while
    // the shell has never been granted native permission. Do not keep a switch
    // on that cannot deliver; the settings toggle will ask for it again.
    if (
      (readNotify("done") || readNotify("question")) &&
      !(await mod.isPermissionGranted())
    ) {
      saveNotify("done", false);
      saveNotify("question", false);
    }
    const { onAction } = mod;
    await onAction((event) => {
      if (event.actionId !== "tap") return;
      const id = event.notification?.extra?.sessionId;
      if (typeof id === "string" && id) void focusSession(id);
    });
    actionsInstalled = true;
  })().finally(() => {
    actionsInstalling = undefined;
  });
  return actionsInstalling;
}

/**
 * Ask the shell, not the webview, for permission. WebKit's Notification is not
 * wired to Notification Center in a Tauri window, so the native plugin is the
 * path that actually delivers a banner; the browser path remains for UI-only
 * iteration.
 */
export async function enableNotify(kind: NotifyKind): Promise<boolean> {
  if (inDesktopShell()) {
    try {
      let granted = await desktopPermission();
      if (!granted) granted = await requestDesktopPermission();
      if (!granted) {
        saveNotify(kind, false);
        return false;
      }
      // Click handling is a convenience; a failure there must not turn off
      // notifications that the OS has already allowed.
      await installNotifyActions().catch(() => {});
      saveNotify(kind, true);
      return true;
    } catch {
      saveNotify(kind, false);
      return false;
    }
  }
  if (typeof Notification === "undefined") {
    saveNotify(kind, false);
    return false;
  }
  if (Notification.permission === "granted") {
    saveNotify(kind, true);
    return true;
  }
  if (Notification.permission === "denied") {
    saveNotify(kind, false);
    return false;
  }
  const granted = (await Notification.requestPermission()) === "granted";
  saveNotify(kind, granted);
  return granted;
}

export function disableNotify(kind: NotifyKind) {
  saveNotify(kind, false);
}

/** Background means minimized or merely behind another window. */
function inBackground(): boolean {
  return document.hidden || !document.hasFocus();
}

/** A quiet chime — the caller decides when one is due. */
function chime() {
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
async function focusSession(sessionId: string | undefined) {
  if (sessionId) location.hash = `/session/${encodeURIComponent(sessionId)}`;
  if (inDesktopShell()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      await current.show();
      await current.setFocus();
      return;
    } catch {
      // fall through to the webview's own focus
    }
  }
  window.focus();
}

async function systemNotification(
  title: string,
  body: string | undefined,
  sessionId: string | undefined,
) {
  if (inDesktopShell()) {
    try {
      await sendDesktop(title, body, sessionId);
      void installNotifyActions().catch(() => {});
    } catch (e) {
      // The chime still fires; a notification that cannot be delivered must
      // not take the session state down with it. The About test surfaces the
      // same error to the reader.
      console.error("strata: notification failed", e);
    }
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const notice = new Notification(title, {
    ...(body ? { body } : {}),
    ...(sessionId ? { tag: sessionId } : {}),
  });
  notice.onclick = () => {
    void focusSession(sessionId);
    notice.close();
  };
}

/** A quiet chime plus a system notification, and only while this window is in
 *  the background and the reader has the kind switched on. */
function announce(kind: NotifyKind, title: string, body: string | undefined, sessionId?: string) {
  if (!readNotify(kind) || !inBackground()) return;
  void systemNotification(title, body, sessionId);
  chime();
}

/** A session's turn ended. */
export function announceFinished(title: string, sessionId?: string) {
  announce("done", title, undefined, sessionId);
}

/** A session has stopped and is waiting on the reader. */
export function announceNeedsInput(title: string, sessionId?: string) {
  announce("question", t("notify.needsInput"), title, sessionId);
}

/** Send a banner even while focused, so Settings can prove the path works. */
export async function sendTestNotification(): Promise<void> {
  if (!inDesktopShell()) throw new Error(t("notify.desktopOnly"));
  await sendDesktop(t("notify.test.title"), t("notify.test.body"), undefined);
}

export async function openNotificationSettings(): Promise<void> {
  if (!inDesktopShell()) throw new Error(t("notify.desktopOnly"));
  await desktopInvoke("open_notification_settings");
}
