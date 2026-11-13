/**
 * One place for clipboard writes. `navigator.clipboard` is missing on
 * plain-HTTP contexts and can reject when the document lacks focus, so a copy
 * that silently does nothing is worse than a legacy path that works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Rejection — or a synchronous throw — falls through to the textarea path.
  }
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute(
    "style",
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none",
  );
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    if (prev?.focus && prev.isConnected) prev.focus();
  }
}

import { inDesktopShell } from "./shell";

/**
 * Pixels for the clipboard, or the address when pixels cannot be had.
 *
 * WKWebView exposes no way to write an image at all — `clipboard.write` and
 * `ClipboardItem` are both missing — so the desktop shell asks the native
 * clipboard instead; the web path stays for browsers, where PNG is the only
 * type `clipboard.write` accepts. A source the page cannot read — a file the
 * shell will not serve, a remote image without CORS — falls back to the
 * address, which is still the useful thing to carry away.
 */
export async function copyImage(src: string): Promise<boolean> {
  try {
    const png = await pngOf(src);
    if (png && inDesktopShell()) {
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeImage(new Uint8Array(await png.arrayBuffer()));
      return true;
    }
    if (png && typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    }
  } catch {
    // Fall through to the address.
  }
  return src ? copyText(src) : false;
}

/**
 * The bytes behind a `data:` URL, without going through `fetch`.
 *
 * `fetch` is governed by `connect-src`, and the shell's policy only lists the
 * loopback origins there — `data:` and `blob:` are allowed for `img-src` alone.
 * So fetching a data URL is refused by CSP in any Chromium webview: the copy
 * then fell through to the address fallback and put a base64 paragraph on the
 * clipboard. WebKit does not police `connect-src` for data URLs, which is why
 * the same code appeared to work on macOS and not on Windows.
 *
 * Decoding here is also just shorter: no request, no blob round-trip. Returns
 * undefined for anything that is not a data URL this can read.
 */
export function decodeDataUrl(src: string): Blob | undefined {
  if (!src.startsWith("data:")) return undefined;
  const comma = src.indexOf(",");
  if (comma < 0) return undefined;
  const meta = src.slice(5, comma);
  const body = src.slice(comma + 1);
  const mime = meta.split(";")[0] || "application/octet-stream";
  try {
    if (meta.includes(";base64")) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch {
    // Malformed base64 or a broken escape: nothing to hand to the clipboard.
    return undefined;
  }
}

async function pngOf(src: string): Promise<Blob | undefined> {
  // A data URL is already in hand — `fetch` would only be refused by CSP.
  const blob = decodeDataUrl(src) ?? (await (await fetch(src)).blob());
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0);
    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((b) => resolve(b ?? undefined), "image/png"),
    );
  } finally {
    bmp.close();
  }
}
