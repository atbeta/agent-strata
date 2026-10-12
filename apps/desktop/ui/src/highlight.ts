/**
 * A small token highlighter for code in the transcript.
 *
 * Deliberately not a parser. Shiki or highlight.js would add a megabyte of
 * grammars and a WASM boot to an app whose code surface is a few hundred tokens
 * of tool output at a time. What ships here is a single scanner that recognises
 * comments, strings, numbers and keywords — the four things a reader actually
 * uses to orient in a snippet — and leaves everything else as plain text.
 *
 * Tokens are emitted as spans with a `tok-*` class rather than inline colours,
 * so the palette stays in the theme.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "punct"
  | "prop"
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
 * Guess a grammar from the text itself. Used for tool results, which arrive
 * with no label at all.
 */
export function guessGrammar(src: string): keyof typeof GRAMMARS | null {
  const head = src.slice(0, 400).trim();
  if (!head) return null;
  if (/^[[{]/.test(head) && /["'][\w$-]*["']\s*:/.test(head)) return "json";
  if (/^(#!\/|\$ |> )/.test(src) || /\b(bun|npm|pnpm|yarn|git|cd|ls|cat|curl)\b/.test(head)) return "sh";
  if (/^(from|import)\s+\S+\s+import\b|^(def|class)\s+\w+.*:\s*$/m.test(src)) return "py";
  if (/\b(const|let|function|=>|interface|export)\b/.test(head)) return "ts";
  return null;
}

function push(out: Token[], kind: TokenKind, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

export function tokenize(src: string, grammar: keyof typeof GRAMMARS | null): Token[] {
  if (!grammar) return [{ kind: "plain", text: src }];
  const g = GRAMMARS[grammar];
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const rest = src.slice(i);
    const bol = i === 0 || src[i - 1] === "\n";

    if (g.hashHeading && bol && rest.startsWith("#")) {
      const nl = rest.indexOf("\n");
      const end = nl === -1 ? rest.length : nl;
      push(out, "keyword", rest.slice(0, end));
      i += end;
      continue;
    }

    if (g.lineComment) {
      const at = rest.indexOf(g.lineComment);
      if (at === 0) {
        const nl = rest.indexOf("\n");
        const end = nl === -1 ? rest.length : nl;
        push(out, "comment", rest.slice(0, end));
        i += end;
        continue;
      }
    }

    if (g.blockComment) {
      const at = rest.indexOf(g.blockComment[0]);
      if (at === 0) {
        const close = rest.indexOf(g.blockComment[1], g.blockComment[0].length);
        const end = close === -1 ? rest.length : close + g.blockComment[1].length;
        push(out, "comment", rest.slice(0, end));
        i += end;
        continue;
      }
    }

    const ch = src[i]!;
    if (g.quotes.includes(ch)) {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === ch) { j += 1; break; }
        else if (src[j] === "\n") break; // unterminated — do not swallow the rest
        else j += 1;
      }
      const end = Math.min(j, src.length);
      push(out, "string", src.slice(i, end));
      i = end;
      continue;
    }

    const num = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?/.exec(rest);
    if (num) {
      push(out, "number", num[0]);
      i += num[0].length;
      continue;
    }

    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      push(out, g.keywords.has(word[0]) ? "keyword" : "plain", word[0]);
      i += word[0].length;
      continue;
    }

    if (/[{}[\]();,.:<>=+\-*/%!&|^~?]/.test(ch)) {
      push(out, "punct", ch);
      i += 1;
      continue;
    }

    push(out, "plain", ch);
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
    else push(out, /^@@/.test(line) ? "keyword" : "plain", line);
    if (i < lines.length - 1) push(out, "plain", "\n");
  });
  return out;
}