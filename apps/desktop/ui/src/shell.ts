/** True when the UI is hosted in the Tauri webview rather than a browser tab. */
export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
