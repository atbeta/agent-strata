export type FileKind = {
  mark?: string;
  icon?: "page" | "branch" | "gear";
  tone: string;
};

const marks: Record<string, { mark: string; tone: string }> = {
  js: { mark: "JS", tone: "bg-yellow-400/15 text-yellow-300" },
  jsx: { mark: "JS", tone: "bg-yellow-400/15 text-yellow-300" },
  mjs: { mark: "JS", tone: "bg-yellow-400/15 text-yellow-300" },
  cjs: { mark: "JS", tone: "bg-yellow-400/15 text-yellow-300" },
  ts: { mark: "TS", tone: "bg-sky-400/15 text-sky-300" },
  tsx: { mark: "TS", tone: "bg-sky-400/15 text-sky-300" },
  mts: { mark: "TS", tone: "bg-sky-400/15 text-sky-300" },
  cts: { mark: "TS", tone: "bg-sky-400/15 text-sky-300" },
  md: { mark: "MD", tone: "text-sky-300" },
  mdx: { mark: "MD", tone: "text-sky-300" },
  json: { mark: "{}", tone: "text-green-300" },
  jsonc: { mark: "{}", tone: "text-green-300" },
  json5: { mark: "{}", tone: "text-green-300" },
  py: { mark: "Py", tone: "text-sky-300" },
  rs: { mark: "RS", tone: "text-orange-300" },
  go: { mark: "Go", tone: "text-cyan-300" },
  rb: { mark: "RB", tone: "text-red-300" },
  java: { mark: "J", tone: "text-orange-300" },
  php: { mark: "P", tone: "text-violet-300" },
  cs: { mark: "C#", tone: "text-violet-300" },
  c: { mark: "C", tone: "text-sky-300" },
  h: { mark: "H", tone: "text-sky-300" },
  cpp: { mark: "C++", tone: "text-sky-300" },
  css: { mark: "CSS", tone: "text-sky-300" },
  scss: { mark: "S", tone: "text-pink-300" },
  html: { mark: "<>", tone: "text-orange-300" },
  xml: { mark: "<>", tone: "text-orange-300" },
  vue: { mark: "V", tone: "text-green-300" },
  svelte: { mark: "S", tone: "text-orange-300" },
  sh: { mark: ">_", tone: "text-green-300" },
  bash: { mark: ">_", tone: "text-green-300" },
  zsh: { mark: ">_", tone: "text-green-300" },
  fish: { mark: ">_", tone: "text-green-300" },
  pdf: { mark: "PDF", tone: "text-red-300" },
  doc: { mark: "DOC", tone: "text-sky-300" },
  docx: { mark: "DOC", tone: "text-sky-300" },
  xls: { mark: "XLS", tone: "text-green-300" },
  xlsx: { mark: "XLS", tone: "text-green-300" },
  csv: { mark: "CSV", tone: "text-green-300" },
  ppt: { mark: "PPT", tone: "text-orange-300" },
  pptx: { mark: "PPT", tone: "text-orange-300" },
};

const configFiles = new Set(["cfg", "conf", "env", "ini", "toml", "yaml", "yml"]);

export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") {
    return { icon: "branch", tone: "text-orange-300" };
  }
  const extension = lower.includes(".") ? lower.split(".").at(-1)! : "";
  const marked = marks[extension];
  if (marked) return marked;
  if (configFiles.has(extension)) return { icon: "gear", tone: "text-sky-300" };
  return { icon: "page", tone: "text-muted-foreground/70" };
}
