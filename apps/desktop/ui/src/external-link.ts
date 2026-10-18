/**
 * Handing a link to the browser that is already open.
 *
 * Every link in this app was a bare `<a target="_blank">`, and in a Tauri
 * webview `target="_blank"` is not "open a new window" — it is a navigation
 * request the webview satisfies itself. On Windows that is a new WebView2
 * instance inside the same window frame, and because the app's own page is
 * gone from it, the window is left showing an empty frame: the app looks like
 * it crashed, and the reader's work with it. There is no address bar, no
 * back button, and no way back to the conversation.
 *
 * So links are intercepted and given to the OS instead. The webview is the one
 * that must not navigate, which means this is a `click` concern rather than a
 * `target` one.
 */

/** Schemes the OS may be asked to open. Everything else is refused. */
const OPENABLE = /^(https?:|mailto:)/i;

/**
 * Whether a URL may be handed to the OS.
 *
 * `javascript:` is the reason this is a whitelist and not a blacklist. A
 * model can be talked into writing `[click me](javascript:...)` into a reply,
 * and a blacklist that had to enumerate the dangerous schemes would be a
 * blacklist that gets extended after the next one is found. Refusing
 * everything unrecognised means a scheme nobody thought of is refused by
 * default.
 */
export function isOpenableUrl(href: string | undefined | null): boolean {
  if (!href) return false;
  // A protocol-relative URL (`//example.com`) inherits the page's scheme, which
  // in a webview is `tauri:`. It is a web address and is worth opening.
  if (href.startsWith("//")) return true;
  return OPENABLE.test(href.trim());
}

/**
 * The URL to open, or null when it is the app navigating to itself.
 *
 * Internal routes are a `location.hash` walk and must stay inside: handing
 * `#/session/xyz` to the OS would open a browser tab pointed at a hash on the
 * dev origin, which is not what the reader clicked.
 */
export function externalUrlFor(
  href: string,
  locationHref: string,
): string | null {
  if (!isOpenableUrl(href)) return null;
  const target = href.trim();
  if (target.startsWith("#")) return null;
  // Same-document: a hash on the page we are already showing.
  if (target.startsWith(locationHref.split("#")[0]!) && target.includes("#")) {
    const here = locationHref.split("#")[0];
    if (target.startsWith(here)) return null;
  }
  return target.startsWith("//") ? `https:${target}` : target;
}
