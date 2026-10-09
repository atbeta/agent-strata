/**
 * Terminal control sequences, stripped.
 *
 * Tool results come from real shells. PowerShell and friends colour their output
 * with SGR escapes, and once that text lands in a <pre> the escapes render as
 * literal `[31;1m` noise between every word. The alternative — a full ANSI
 * terminal emulator in a side panel — is far more than a transcript drawer
 * needs, so we drop the codes and keep the text.
 */

/** A global regex carries `lastIndex` between `.test()` calls, so the detection
 *  and replacement forms are built separately from one source. */
function both(source: string): [probe: RegExp, global: RegExp] {
  return [new RegExp(source), new RegExp(source, "g")];
}

// OSC strings (ESC ] … BEL, or ESC ] … ESC \) carry window titles and never
// render. Handled before the CSI rule because their payload may itself contain
// the `;` and digits that the CSI pattern would half-consume.
const [, OSC_ALL] = both("\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)");
const [OSC_PROBE] = both("\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)");

// CSI sequences (ESC [ … final byte) and the short two-byte escapes. Covers what
// a shell emits for colour and cursor movement, and stops at the terminator so
// ordinary text after it survives.
const CSI_SOURCE =
  "[\\u001B\\u009B][[\\]()#;?]*" +
  "(?:" +
  "(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])" +
  ")";
const [CSI_PROBE, CSI_ALL] = both(CSI_SOURCE);

// An SGR whose introducer was already eaten upstream, so it reaches us as bare
// `[31;1m`. Shell output crosses JSON, SQLite and the drawer on the way here,
// and somewhere along that path the ESC byte is the one thing that does not
// survive — leaving the colour code visible as text. The shape is narrow enough
// (digits and semicolons, terminated by `m`) that prose will not match it.
const [ORPHAN_PROBE, ORPHAN_ALL] = both("\\[[0-9;]{1,12}m");

// The same damage one byte further along: `0m` left where `ESC[0m` used to be.
// Anchored to the start of a line, because that is where a truncated SGR lands —
// mid-line the shape is indistinguishable from ordinary text like `50ms`, so it
// is left alone rather than guessed at.
const [, ORPHAN_TAIL_ALL] = both("(^|\\n)[0-9]{1,2}m");

// Leftover C0/C1 controls with no glyph. Tab, newline and carriage return stay:
// they are the output's own formatting, not artefacts.
const [, CONTROL_ALL] = both("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]");

function marked(input: string): boolean {
  return OSC_PROBE.test(input) || CSI_PROBE.test(input) || ORPHAN_PROBE.test(input);
}

export function stripAnsi(input: string): string {
  if (!input) return input;
  const wasMarked = marked(input);
  let out = input
    .replace(OSC_ALL, "")
    .replace(CSI_ALL, "")
    .replace(ORPHAN_ALL, "")
    .replace(CONTROL_ALL, "");
  if (wasMarked) out = out.replace(ORPHAN_TAIL_ALL, "$1");
  return out;
}

/** True when the text carries terminal escapes worth stripping. */
export function hasAnsi(input: string): boolean {
  return !!input && marked(input);
}