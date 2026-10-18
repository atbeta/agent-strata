import { externalUrlFor, isOpenableUrl } from "./external-link";
import { inDesktopShell } from "./shell";

/**
 * Send every link in the app to the system browser, once, for the whole tree.
 *
 * Written as a delegated listener on the document rather than as an `onClick`
 * on each of the dozen `<a>` elements that exist today, and on any that are
 * added later — markdown output included, which is rendered at runtime and so
 * could not carry a handler written by hand anyway.
 *
 * `preventDefault` is the whole point. Without it the webview navigates and
 * takes the window with it; with it the click never becomes a navigation.
 */
export function installExternalLinkHandler(): () => void {
  if (!inDesktopShell()) return () => {};
  const onClick = (event: MouseEvent) => {
    // Let the reader copy a link, open it in a new tab deliberately, or middle
    // click it. Only the plain left click on the primary button is ours.
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    // An in-app route, or something the OS will not open.
    if (!isOpenableUrl(href)) return;

    const url = externalUrlFor(href!, window.location.href);
    if (!url) return;

    event.preventDefault();
    void openExternally(url);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

/**
 * Ask the OS to open a URL.
 *
 * The plugin is imported lazily so the browser build — and the tests, and the
 * dev server served over http — never touch it. `tauri_plugin_shell` needs a
 * Rust side that is only present in the packaged app, and a static import
 * would fail to resolve rather than fail to run.
 */
async function openExternally(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch (err) {
    console.error("could not hand the link to the browser:", err);
  }
}
