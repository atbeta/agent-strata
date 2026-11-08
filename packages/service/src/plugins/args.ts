/**
 * The arguments a tool actually accepts.
 *
 * A model is told the JSON Schema and is free to send something else. Two
 * shapes keep arriving in practice, and both used to reach the tool as
 * written:
 *
 * - the schema object instead of an instance of it, so the real argument
 *   arrives as `{ properties: { url } }`;
 * - that same object JSON-encoded into a string, sometimes twice:
 *   `{ properties: '{"properties":{"url":"http://localhost:4321/"}}' }`.
 *
 * The second one is what a page-opening tool got from an agent that had
 * resorted to guessing: it answered "not a URL an agent may open: undefined"
 * — a tool failure that looks like a bad URL rather than a bad argument.
 *
 * Unwrapping is only done for a *single* key named like a parameter bag, and
 * never for a key the schema itself declares, so a tool that genuinely takes
 * `properties` keeps working.
 */

const WRAPPERS = new Set(["properties", "arguments", "input", "params"]);

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON; the tool will report the shape it needs.
  }
  return undefined;
}

export function coerceToolInput(
  schema: { properties?: Record<string, unknown> } | undefined,
  raw: unknown,
): Record<string, unknown> {
  let value = raw;
  for (let depth = 0; depth < 4; depth++) {
    const object = parseObject(value);
    if (object) {
      value = object;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const declared = schema?.properties ?? {};
    if (keys.length === 1) {
      const key = keys[0]!;
      if (WRAPPERS.has(key) && !(key in declared)) {
        value = record[key];
        continue;
      }
    }
    return record;
  }
  return {};
}
