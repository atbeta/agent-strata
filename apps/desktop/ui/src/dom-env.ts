// A DOM for tests, stood up before the module under test evaluates.
//
// `bun:test` has no DOM, and modules like `dompurify` bind the global
// `window` while they are being imported — registering afterwards is too
// late. Any test that exercises DOM code must import this file FIRST, so
// its side effect runs before the rest of that test's module graph:
//
//   import "./dom-env";   // first import, always
//   import { parsed } from "./md";
//
// It is jsdom, the environment DOMPurify is built against, rather than a
// bunfig preload of a lighter DOM: a global DOM would flip the
// `typeof document === "undefined"` guards several modules carry into
// branches their tests never asked for — and the lighter DOM is also just
// wrong here. Under it `DOMPurify.sanitize` quietly stops sanitising
// (a `<script>` survives, an `onerror` wipes the whole element), so every
// verdict it produced about this pipeline would be a verdict about the
// harness, not the code.
import { JSDOM } from "jsdom";

const { window } = new JSDOM("");

const globals = [
  "window",
  "document",
  "Document",
  "DocumentFragment",
  "DocumentType",
  "Element",
  "HTMLElement",
  "HTMLPreElement",
  "HTMLAnchorElement",
  "HTMLInputElement",
  "SVGElement",
  "Node",
  "NodeFilter",
  "NodeList",
  "Text",
  "Comment",
  "Attr",
  "DOMParser",
  "XMLSerializer",
  "navigator",
  "getComputedStyle",
  "Event",
  "CustomEvent",
  "MutationObserver",
  "HTMLTemplateElement",
] as const;

const target = globalThis as Record<string, unknown>;
for (const key of globals) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value !== undefined) target[key] = value;
}
