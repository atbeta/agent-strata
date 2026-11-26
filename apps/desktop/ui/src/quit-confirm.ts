import { inDesktopShell } from "./shell";

/**
 * Quit confirmation, the page's half.
 *
 * The shell owns the decision points — the window's close button, Cmd+Q on
 * macOS, a programmatic exit — because they all arrive there first. What it
 * cannot own is the question: a prevented close leaves the window standing
 * with nothing on it, so the asking happens here. The shell emits
 * `shell-quit-requested`, the app shows the dialog, and a yes comes back as
 * the `confirm_quit` command. A no is silence: nothing was destroyed, so
 * there is nothing to undo.
 *
 * The setting itself lives in the shell's desktop.json rather than here,
 * because the shell has to read it before the page exists — a close in the
 * first second of a cold start still has to be answered.
 */

export async function readConfirmQuit(): Promise<boolean> {
  if (!inDesktopShell()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<boolean>("read_confirm_exit");
  } catch {
    // An older shell has no such command, and no question asked is the same
    // as the setting never having been written.
    return false;
  }
}

export async function saveConfirmQuit(on: boolean): Promise<void> {
  if (!inDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_confirm_exit", { enabled: on });
}

/** The yes answer to the shell's question. The no answer needs no command:
 *  the shell never acted, so there is nothing to take back. */
export async function confirmQuit(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("confirm_quit");
}

/**
 * Subscribe to the shell's quit requests. Resolves to the unsubscribe; outside
 * the desktop shell nothing ever fires and the unsubscribe is a no-op.
 */
export async function installQuitListener(handler: () => void): Promise<() => void> {
  if (!inDesktopShell()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("shell-quit-requested", () => handler());
}
