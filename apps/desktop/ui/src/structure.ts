/**
 * Deciding what a tool payload *is*, kept apart from how it is drawn.
 *
 * Tool input and output reach the UI as raw event data: sometimes an object,
 * sometimes a JSON string a backend chose to embed, sometimes shell text. The
 * view needs a stable answer to "is this structure or text", and so does every
 * caller deciding whether a payload is worth expanding — so it lives here, in a
 * module with no JSX, where the test runner can reach it without a JSX runtime.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "object" ? "object" : (t as JsonKind);
}

/** An object or array, either natively or as a string that parses to one. */
export function looksStructured(value: unknown): boolean {
  if (value !== null && typeof value === "object") return true;
  if (typeof value !== "string") return false;
  const head = value.trimStart();
  if (!/^[[{]/.test(head)) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

/** Parse a string payload back into a value when it is JSON; otherwise pass it through. */
export function asStructure(value: unknown): unknown {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Beyond this many entries a listing stops being something anyone scans. */
export const MAX_ENTRIES = 200;

export function entriesOf(value: unknown): ReadonlyArray<readonly [string, unknown]> {
  if (Array.isArray(value)) return value.map((item, i) => [String(i), item] as const);
  if (value && typeof value === "object") {
    const all = Object.entries(value as Record<string, unknown>);
    return all.length > MAX_ENTRIES ? all.slice(0, MAX_ENTRIES) : all;
  }
  return [];
}

/** A one-line sketch of a collapsed container: `{a, b, …}`. */
export function summaryOf(kind: JsonKind, keys: string[]): string {
  if (kind === "array") return `[${keys.length}]`;
  if (keys.length === 0) return "{}";
  const shown = keys.slice(0, 4).join(", ");
  return keys.length > 4 ? `{${shown}, …}` : `{${shown}}`;
}