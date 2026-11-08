// The page-side snapshot pass.
//
// Kept as source text rather than a function because CDP's
// `Runtime.evaluate` takes an expression. It marks every interactive element
// it can see with a short ref and returns the list a model reads.
//
// A ref is only honest until the page changes, so every action answers with a
// fresh pass. That rule is what makes a stale ref a clean failure instead of a
// click on whatever moved into its place.

/** Selectors that count as "a thing a person can act on". */
const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable=''],[contenteditable='true']",
  "[role]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * The expression for one pass.
 *
 * The element that gets the ref is the one the browser considers actionable:
 * an `<a>` wrapping a `<span>` gets the ref on the anchor, so clicking the
 * ref clicks the link rather than the text inside it.
 */
export function snapshotExpression(maxElements: number): string {
  return `(() => {
  const REF = "data-strata-ref";
  const SELECTOR = ${JSON.stringify(SELECTOR)};
  const MAX = ${JSON.stringify(maxElements)};
  document.querySelectorAll("[" + REF + "]").forEach((el) => el.removeAttribute(REF));
  const TAG_ROLE = { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button" };
  const INPUT_ROLE = { button: "button", checkbox: "checkbox", radio: "radio", range: "slider", submit: "button", reset: "button", search: "searchbox" };
  const roleOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLE[type] || "textbox";
    }
    return TAG_ROLE[tag] || "generic";
  };
  const nameOf = (el) => {
    const direct = el.getAttribute("aria-label");
    if (direct && direct.trim()) return direct.trim().slice(0, 120);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\\s+/)
        .map((id) => { const node = document.getElementById(id); return node && node.textContent ? node.textContent.trim() : ""; })
        .filter(Boolean).join(" ");
      if (text) return text.slice(0, 120);
    }
    const own = (el.innerText || el.textContent || "").trim();
    if (own) return own.replace(/\\s+/g, " ").slice(0, 120);
    const attrs = ["placeholder", "title", "alt", "value", "name"];
    for (const attr of attrs) {
      const v = el.getAttribute(attr);
      if (v && v.trim()) return v.trim().slice(0, 120);
    }
    return "";
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity === "0") return false;
    return true;
  };
  const elements = [];
  let found = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    found += 1;
    if (elements.length >= MAX) continue;
    if (!visible(el)) continue;
    const ref = "e" + (elements.length + 1);
    el.setAttribute(REF, ref);
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const row = { ref, role: roleOf(el), tag };
    if (name) row.name = name;
    if (type) row.type = type;
    if (disabled) row.disabled = true;
    elements.push(row);
  }
  return { url: location.href, title: document.title, elements, truncated: Math.max(0, found - elements.length) };
})()`;
}

/** Find one ref's box, in page pixels, for a real input event. */
export function boxExpression(ref: string): string {
  return `(() => {
  const el = document.querySelector('[data-strata-ref="${ref.replace(/"/g, "")}"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
})()`;
}

/**
 * Set a field's value the way a framework notices.
 *
 * Assigning `.value` directly updates the DOM property but not React's or
 * Vue's state, so the next render puts the old value back and the form submits
 * nothing. The entry that fires is the one a person typing would fire, with
 * the property set through the native setter that the framework has wrapped.
 */
export function fillExpression(ref: string, text: string): string {
  const safeRef = ref.replace(/"/g, "");
  const json = JSON.stringify(text);
  return `(() => {
  const el = document.querySelector('[data-strata-ref="${safeRef}"]');
  if (!el) return { ok: false, why: "not on the page" };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value");
  if (setter && setter.set) setter.set.call(el, ${json});
  else el.value = ${json};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
})()`;
}

/** Trigger a `<select>`'s change event after choosing by visible label. */
export function selectExpression(ref: string, label: string): string {
  const safeRef = ref.replace(/"/g, "");
  const json = JSON.stringify(label);
  return `(() => {
  const el = document.querySelector('[data-strata-ref="${safeRef}"]');
  if (!el || el.tagName.toLowerCase() !== "select") return { ok: false, why: "not a select" };
  const wanted = ${json};
  const option = Array.from(el.options).find((o) => o.label === wanted || o.text === wanted || o.value === wanted);
  if (!option) return { ok: false, why: "no option called " + wanted };
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: option.value };
})()`;
}

/** Focus a ref so a key press or text insertion lands in it. */
export function focusExpression(ref: string): string {
  const safeRef = ref.replace(/"/g, "");
  return `(() => {
  const el = document.querySelector('[data-strata-ref="${safeRef}"]');
  if (!el) return { ok: false, why: "not on the page" };
  el.focus();
  return { ok: true };
})()`;
}

/** Hover: dispatch the pointer events a hover handler waits for. */
export function hoverExpression(ref: string): string {
  const safeRef = ref.replace(/"/g, "");
  return `(() => {
  const el = document.querySelector('[data-strata-ref="${safeRef}"]');
  if (!el) return { ok: false, why: "not on the page" };
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: type !== "pointerenter" && type !== "mouseenter" }));
  }
  return { ok: true };
})()`;
}
