// The platform version, and the range check a manifest can ask about.
//
// A plugin declares `engines.strata`; the host refuses to load a plugin that
// wanted something newer than what is running, and says why. The version lives
// here rather than being read from package.json because the sidecar is a
// compiled binary with no package file beside it — and a single constant with
// a test that compares it to the shell's version is harder to let drift than a
// file that only exists in development.

/**
 * The strata version this host reports.
 *
 * Must equal `apps/desktop/src-tauri/tauri.conf.json`'s `version`; a test in
 * `packages/plugin-sdk/test` fails when they disagree. Bump both together.
 */
export const STRATA_VERSION = "0.32.3";

type Comparator = { op: ">=" | ">" | "<=" | "<" | "="; version: [number, number, number] };

/** Parse `1.2.3` (a trailing `-prerelease` is ignored, as it is below its release). */
function parseVersion(text: string): [number, number, number] | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!m) return undefined;
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether `version` satisfies `range`.
 *
 * The ranges a manifest can write are the simple ones: comma-joined
 * comparators (`>=0.28.0`, `>=0.24.0 <0.30.0`), a bare version meaning `=`,
 * `^`/`~` sugar, and `*`. Anything else is a range this host cannot judge —
 * and a plugin that wants to be loaded fails there rather than silently
 * loading, because "I could not read your requirement" is not "yes".
 */
export function satisfiesRange(version: string, range: string): { ok: boolean; reason?: string } {
  const actual = parseVersion(version);
  if (!actual) return { ok: false, reason: `not a version: ${version}` };
  const text = range.trim();
  if (text === "" || text === "*") return { ok: true };

  const comparators: Comparator[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    if (raw === "*") continue;
    const expanded = expandSugar(raw);
    if (!expanded) return { ok: false, reason: `unsupported version range "${range}"` };
    comparators.push(...expanded);
  }
  for (const c of comparators) {
    const d = compare(actual, c.version);
    const ok =
      c.op === ">=" ? d >= 0 : c.op === ">" ? d > 0 : c.op === "<=" ? d <= 0 : c.op === "<" ? d < 0 : d === 0;
    if (!ok) return { ok: false, reason: `requires ${range}, this is ${version}` };
  }
  return { ok: true };
}

/** `^1.2.3` -> `>=1.2.3 <2.0.0`; `~1.2.3` -> `>=1.2.3 <1.3.0`; bare -> `=`. */
function expandSugar(token: string): Comparator[] | undefined {
  const caret = token.startsWith("^");
  const tilde = token.startsWith("~");
  if (caret || tilde) {
    const base = parseVersion(token.slice(1));
    if (!base) return undefined;
    const [major, minor] = base;
    const upper: [number, number, number] = caret ? [major + 1, 0, 0] : [major, minor + 1, 0];
    return [
      { op: ">=", version: base },
      { op: "<", version: upper },
    ];
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return undefined;
  const version = parseVersion(m[2] ?? "");
  if (!version) return undefined;
  return [{ op: (m[1] as Comparator["op"] | undefined) ?? "=", version }];
}
