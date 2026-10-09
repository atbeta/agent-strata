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
export function usesOverlayTrafficLights(): boolean {
  return shellPlatform() === "macos";
}

/**
 * Windows has no native title bar (decorations are turned off in the shell).
 * Linux keeps the system title bar.
 */
export function usesCustomCaption(): boolean {
  return shellPlatform() === "windows";
}
