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

/**
 * Pixels for the clipboard, or the address when pixels cannot be had.
 *
 * `clipboard.write` accepts PNG and nothing else in WebKit, so whatever the
 * source was is decoded and re-encoded once. A source the page cannot read —
 * a file the shell will not serve, a remote image without CORS — falls back
 * to the address, which is still the useful thing to carry away.
 */
export async function copyImage(src: string): Promise<boolean> {
  try {
    const png = await pngOf(src);
    if (png && typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    }
  } catch {
    // Fall through to the address.
  }
  return src ? copyText(src) : false;
}

async function pngOf(src: string): Promise<Blob | undefined> {
  const blob = await (await fetch(src)).blob();
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
