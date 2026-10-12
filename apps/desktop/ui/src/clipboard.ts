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
