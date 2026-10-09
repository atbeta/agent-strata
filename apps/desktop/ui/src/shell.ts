/** True when the UI is hosted in the Tauri webview rather than a browser tab. */
export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type ShellPlatform = "macos" | "windows" | "linux";

/** Desktop OS, or null when this page is an ordinary browser tab. */
export function shellPlatform(): ShellPlatform | null {
  if (!inDesktopShell()) return null;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  return "linux";
}

/** macOS draws traffic lights over the top-left of the webview. */
function isMac(): boolean {
  return shellPlatform() === "macos";
}

/**
 * Windows has no native title bar (decorations are turned off in the shell).
 * Linux keeps the system title bar.
 */
export function usesCustomCaption(): boolean {
  return shellPlatform() === "windows";
}

/**
 * True when the shell draws its own top strip: Windows for the caption it
 * invents, macOS so the overlay traffic lights have a row to sit on. Linux and
 * the browser keep the OS title bar and need no strip of their own.
 */
export function drawsOwnTopStrip(): boolean {
  return isMac() || usesCustomCaption();
}
