/**
 * A small token highlighter for code in the transcript.
 *
 * Deliberately not a parser. Shiki or highlight.js would add a megabyte of
 * grammars and a WASM boot to an app whose code surface is a few hundred tokens
 * of tool output at a time. What ships here is a single scanner that recognises
 * the landmarks a reader uses to orient in a snippet — comments, literals,
 * keywords, calls, properties and types — and leaves everything else plain.
 *
 * Tokens are emitted as spans with a `tok-*` class rather than inline colours,
 * so the palette stays in the theme.
 */

export type TokenKind =
  | "plain"
  // Log levels in a tool's output: not a language, a place to look.
  | "log-error"
  | "log-warn"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "func"
  | "prop"
  | "type"
  | "punct"
  | "add"
  | "del";

export interface Token {
  kind: TokenKind;
  text: string;
}

interface Grammar {
  lineComment?: string;
  blockComment?: [string, string];
  /** quote characters; a backslash escapes the next character inside them */
  quotes: string[];
  keywords: Set<string>;
  /** Markdown headings: a line that starts with `#` is one token. */
  hashHeading?: boolean;
}

const JS_KEYWORDS =
  "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return satisfies set static super switch this throw try type typeof var void while with yield";

const PY_KEYWORDS =
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield";

const SH_KEYWORDS =
  "if then else elif fi for while until do done case esac function return in select time coproc local export readonly declare source alias unalias set unset trap shift eval exec exit";

const RUST_KEYWORDS =
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while";

const GO_KEYWORDS =
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var";

const JAVA_KEYWORDS =
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try var void volatile while yield";

const C_KEYWORDS =
  "auto break case char class const continue default do double else enum extern float for goto if inline int long namespace private protected public register return short signed sizeof static struct switch template typedef union unsigned virtual void volatile while";

const CSS_KEYWORDS =
  "import media supports keyframes from to important charset layer";

const HTML_KEYWORDS =
  "html head body div span a p ul ol li script style link meta form input button table tr td th section article nav header footer";

const SQL_KEYWORDS =
  "select from where and or not insert into values update set delete join left right inner outer on group by order limit offset as create table drop alter index primary key null is in like between union all distinct having";

const RB_KEYWORDS =
  "def end class module if elsif else unless while until for do begin rescue ensure return yield self nil true false and or not in";

const PHP_KEYWORDS =
  "function class public private protected return if else elseif foreach as while do echo new namespace use extends implements static abstract interface trait";

const LUA_KEYWORDS =
  "and break do else elseif end false for function goto if in local nil not or repeat return then true until while";

const JSON_LITERALS = new Set(["true", "false", "null"]);
const YAML_LITERALS = new Set(["true", "false", "null", "yes", "no"]);

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

const GRAMMARS: Record<string, Grammar> = {
  ts: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: words(JS_KEYWORDS) },
  py: { lineComment: "#", quotes: ['"', "'"], keywords: words(PY_KEYWORDS) },
  sh: { lineComment: "#", quotes: ['"', "'"], keywords: words(SH_KEYWORDS) },
  rust: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"'], keywords: words(RUST_KEYWORDS) },
  go: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "`"], keywords: words(GO_KEYWORDS) },
  java: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"'], keywords: words(JAVA_KEYWORDS) },
  c: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"'], keywords: words(C_KEYWORDS) },
  css: { blockComment: ["/*", "*/"], quotes: ['"', "'"], keywords: words(CSS_KEYWORDS) },
  html: { blockComment: ["<!--", "-->"], quotes: ['"', "'"], keywords: words(HTML_KEYWORDS) },
  sql: { lineComment: "--", blockComment: ["/*", "*/"], quotes: ['"', "'"], keywords: words(SQL_KEYWORDS) },
  rb: { lineComment: "#", quotes: ['"', "'"], keywords: words(RB_KEYWORDS) },
  php: { lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'"], keywords: words(PHP_KEYWORDS) },
  lua: { lineComment: "--", blockComment: ["--[[", "]]"], quotes: ['"', "'"], keywords: words(LUA_KEYWORDS) },
  yaml: { lineComment: "#", quotes: ['"', "'"], keywords: YAML_LITERALS },
  toml: { lineComment: "#", quotes: ['"', "'"], keywords: JSON_LITERALS },
  md: { quotes: ['"', "'", "`"], keywords: new Set(), hashHeading: true },
  json: { quotes: ['"'], keywords: JSON_LITERALS },
};

/** Fence labels and file extensions that share one grammar. */
const LANG: Record<string, keyof typeof GRAMMARS> = {
  json: "json",
  jsonc: "json",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  console: "sh",
  powershell: "sh",
  ps1: "sh",
  python: "py",
  py: "py",
  pyw: "py",
  typescript: "ts",
  javascript: "ts",
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  mts: "ts",
  cts: "ts",
  rust: "rust",
  rs: "rust",
  go: "go",
  golang: "go",
  java: "java",
  kotlin: "java",
  kt: "java",
  kts: "java",
  c: "c",
  h: "c",
  cpp: "c",
  cc: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  cs: "c",
  csharp: "c",
  swift: "c",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "html",
  vue: "html",
  svg: "html",
  sql: "sql",
  ruby: "rb",
  rb: "rb",
  php: "php",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  markdown: "md",
  md: "md",
  lua: "lua",
};

/** Map a fence label or filename onto a grammar key. */
export function grammarFor(label: string | undefined): keyof typeof GRAMMARS | null {
  if (!label) return null;
  const raw = label.toLowerCase().trim();
  if (LANG[raw]) return LANG[raw];
  const base = raw.split(/[/\\]/).pop() ?? raw;
  const dot = base.lastIndexOf(".");
  if (dot >= 0) {
    const ext = base.slice(dot + 1);
    if (LANG[ext]) return LANG[ext];
  }
  return null;
}

/**
 * Guess a grammar from the text itself. Used for tool results and for fenced
 * blocks that carry no label.
 *
 * The rules are deliberately narrow. A word that merely appears in a sentence
 * is not a language: "Please run git status" used to make the whole block
 * shell — and painted "Please" as the command, because the first word of a
 * shell block is always the command. Each rule below needs a shape prose does
 * not have: a prompt, a run of command-shaped lines, or a declaration at the
 * start of a line.
 */
export function guessGrammar(src: string): keyof typeof GRAMMARS | null {
  const head = src.slice(0, 400).trim();
  if (!head) return null;
  if (/^[[{]/.test(head) && /["'][\w$-]*["']\s*:/.test(head)) return "json";

  // A prompt at the start of a line is the strongest shell signal there is.
  if (/^\s*(\$|❯)\s+\S/m.test(src)) return "sh";

  const lines = src.split("\n").slice(0, 12);
  // Unambiguous tools: their name at the start of a line is already a command.
  const strong =
    /^\s*(?:sudo\s+)?(?:bun|npm|pnpm|yarn|npx|cargo|docker|kubectl|git|gh|systemctl|brew|mkdir|curl|wget)\b/;
  // Ordinary ones: a flag, a path or a pipe is what separates `ls -la` from a
  // sentence that happens to begin with "go".
  const anyCommand =
    /^\s*(?:sudo\s+)?(?:cd|ls|cat|rm|cp|mv|grep|rg|sed|awk|find|make|go|node|python3?|tar|chmod|chown|ssh|scp|tail|head|wc|sort|uniq|jq|echo|export|less|touch)\b/;
  const shaped = (line: string) =>
    (strong.test(line) && line.trim().split(/\s+/).length >= 2) ||
    (anyCommand.test(line) && /(\s-{1,2}[\w-]+|\s\/|\s\.{1,2}\/|&&|\|)/.test(line));
  if (lines.length === 1 && shaped(lines[0]!)) return "sh";
  if (lines.filter(shaped).length >= 2) return "sh";

  // Python: a block header at the start of a line, or an import plus a call.
  if (/^\s*(?:async\s+)?(?:def|class)\s+\w+[^\n]*:\s*$/m.test(src)) return "py";
  if (/^\s*(?:import|from)\s+[\w.]+/m.test(src) && /^\s*\w+\(.*\)\s*$/m.test(src)) return "py";

  // TypeScript/JavaScript: a declaration at the start of a line, and code
  // punctuation in the head — prose may well contain the word "function".
  if (/^\s*(?:const|let|var|function|interface|export|import|type)\b/m.test(head) && /[{};=()]/.test(head)) {
    return "ts";
  }
  return null;
}

/**
 * Tint the level words in machine output: `ERROR:` in a stack trace, `[WARN]`
 * in a build log.
 *
 * Only the word is coloured and only where it reads as a marker — followed by
 * `:` or `]`, or sitting inside a bracketed prefix. A sentence that contains
 * the word "error" is a sentence.
 */
const LOG_LEVEL = /\b(ERROR|FATAL|PANIC|CRITICAL|WARN|WARNING|SEVERE)\b/g;

export function tokenizeLogMarkers(src: string): Token[] | null {
  const hits: { at: number; len: number; kind: TokenKind }[] = [];
  for (const match of src.matchAll(LOG_LEVEL)) {
    const at = match.index;
    const after = src.slice(at + match[0].length, at + match[0].length + 2);
    const before = src.slice(Math.max(0, at - 1), at);
    const marker = /^[\]:]/.test(after) || /[[:]/.test(before) || at === 0 || src[at - 1] === "\n";
    if (!marker) continue;
    const kind: TokenKind = /^(ERROR|FATAL|PANIC|CRITICAL|SEVERE)$/.test(match[0]) ? "log-error" : "log-warn";
    hits.push({ at, len: match[0].length, kind });
  }
  if (hits.length === 0) return null;
  const out: Token[] = [];
  let last = 0;
  for (const hit of hits) {
    push(out, "plain", src.slice(last, hit.at));
    push(out, hit.kind, src.slice(hit.at, hit.at + hit.len));
    last = hit.at + hit.len;
  }
  push(out, "plain", src.slice(last));
  return out;
}

function push(out: Token[], kind: TokenKind, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/**
 * Anchored at a position, rather than run against a copy of the tail.
 *
 * This used to take `src.slice(i)` once per iteration and read everything —
 * startsWith, two indexOfs, two regexes — off that copy, so a branch that
 * advanced a character at a time recopied the rest of the file every time.
 * Measured on plain text: 2.1ms at 16KB, 7.5 at 32KB, 27.6 at 64KB, 109 at
 * 128KB. Four times the work for twice the input is quadratic, and half a
 * second on the main thread is what one big code block cost to read.
 *
 * The two comment probes were part of the same bill: each scanned forward
 * through the whole remainder to produce an offset that was only ever compared
 * against zero. A `startsWith` at `i` answers that directly and costs the
 * length of the delimiter.
 */
const NUMBER = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const CSS_WORD = /[A-Za-z_$][\w$-]*/y;
const PUNCT = /[{}[\]();,.:<>=+\-*/%!&|^~?]/;

function nextMeaningful(src: string, at: number): string {
  let ch = src[at] ?? "";
  while (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") ch = src[++at] ?? "";
  return ch;
}

export function tokenize(src: string, grammar: keyof typeof GRAMMARS | null): Token[] {
  if (!grammar) return [{ kind: "plain", text: src }];
  const g = GRAMMARS[grammar];
  const out: Token[] = [];
  const len = src.length;
  let i = 0;
  let shellCommand = grammar === "sh";

  while (i < len) {
    const bol = i === 0 || src[i - 1] === "\n";

    if (g.hashHeading && bol && src.startsWith("#", i)) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? len - i : nl - i;
      push(out, "keyword", src.slice(i, i + end));
      i += end;
      continue;
    }

    if (g.lineComment && src.startsWith(g.lineComment, i)) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? len - i : nl - i;
      push(out, "comment", src.slice(i, i + end));
      i += end;
      continue;
    }

    if (g.blockComment) {
      const [open, close] = g.blockComment;
      if (src.startsWith(open, i)) {
        const at = src.indexOf(close, i + open.length);
        const end = at === -1 ? len : at + close.length;
        push(out, "comment", src.slice(i, end));
        i = end;
        continue;
      }
    }

    const ch = src[i]!;
    if (g.quotes.includes(ch)) {
      let j = i + 1;
      while (j < len) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === ch) { j += 1; break; }
        else if (src[j] === "\n") break; // unterminated — do not swallow the rest
        else j += 1;
      }
      const end = Math.min(j, len);
      const key = grammar === "json" && src[end - 1] === ch && nextMeaningful(src, end) === ":";
      push(out, key ? "prop" : "string", src.slice(i, end));
      i = end;
      continue;
    }

    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num) {
      push(out, "number", num[0]);
      i += num[0].length;
      continue;
    }

    const pattern = grammar === "css" ? CSS_WORD : WORD;
    pattern.lastIndex = i;
    const word = pattern.exec(src);
    if (word) {
      const text = word[0];
      const end = i + text.length;
      const next = nextMeaningful(src, end);
      let kind: TokenKind = "plain";
      if (g.keywords.has(text)) kind = "keyword";
      else if (grammar === "sh") {
        if (text.startsWith("$") || src[i - 1] === "-") kind = "prop";
        else if (shellCommand && next === "=") kind = "prop";
        else if (shellCommand) {
          kind = "func";
          shellCommand = false;
        }
      } else if (grammar === "html" && (src[i - 1] === "<" || (src[i - 1] === "/" && src[i - 2] === "<"))) {
        kind = "keyword";
      } else if ((grammar === "html" || grammar === "toml") && next === "=") kind = "prop";
      else if (/^[A-Z]/.test(text)) kind = "type";
      else if (next === "(") kind = "func";
      else if (next === ":" || src[i - 1] === ".") kind = "prop";
      push(out, kind, text);
      i = end;
      continue;
    }

    if (PUNCT.test(ch)) {
      push(out, "punct", ch);
      if (grammar === "sh" && "|;&(".includes(ch)) shellCommand = true;
      i += 1;
      continue;
    }

    push(out, "plain", ch);
    if (grammar === "sh" && ch === "\n") shellCommand = true;
    i += 1;
  }

  return out;
}

/**
 * Colourise a unified diff by its leading +/- marker. Applied before syntax
 * highlighting would apply, since a patch has no single language.
 */
export function tokenizeDiff(src: string): Token[] | null {
  const lines = src.split("\n");
  const marked = lines.filter((l) => /^[+-]/.test(l)).length;
  // A real patch has a header or a meaningful share of marked lines; shell
  // output with the odd leading `-` should not turn green.
  if (marked < 2 || marked / lines.length < 0.2) return null;
  if (!/^(diff --git|index |--- |\+\+\+ |@@)/m.test(src)) return null;

  const out: Token[] = [];
  lines.forEach((line, i) => {
    const kind: TokenKind | null = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : null;
    if (kind) push(out, kind, line);
    else push(out, line.startsWith("@@") ? "keyword" : "plain", line);
    if (i < lines.length - 1) push(out, "plain", "\n");
  });
  return out;
}