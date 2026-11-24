import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { YAML } from "bun";
import { pathInside } from "./path-inside";
import { canonical } from "./worktree";

export const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_BYTES = 512 * 1024;

export type SkillSource =
  | "opencode-global"
  | "opencode-project"
  | "claude"
  | "agents"
  | "custom"
  | "http"
  | "console"
  | "builtin"
  | "unknown";

export type SkillStatus = "active" | "overridden" | "inactive";
export type SkillReadonlyReason = "remote" | "compatibility" | "custom" | "builtin" | "symlink";

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  autoInvoke: boolean;
}

export interface SkillRecord extends SkillInput {
  key: string;
  id: string;
  location: string;
  source: SkillSource;
  scope: "global" | "project" | "other";
  status: SkillStatus;
  writable: boolean;
  readonlyReason?: SkillReadonlyReason;
  directoryForm: boolean;
  files: string[];
  error?: string;
  managedRoot?: string;
}

export interface ActiveSkill {
  name: string;
  description?: string;
  location: string;
  content: string;
}

export interface ManagedRoot {
  root: string;
  source: "opencode-global" | "opencode-project";
  scope: "global" | "project";
  writable: boolean;
}

interface ParsedSkill {
  data: Record<string, unknown>;
  name: string;
  description: string;
  content: string;
  autoInvoke: boolean;
}

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseSkill(raw: string): ParsedSkill {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) {
    return { data: {}, name: "", description: "", content: text, autoInvoke: true };
  }
  const rest = text.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("frontmatter is not closed");
  const parsed = YAML.parse(rest.slice(0, closing.index));
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("frontmatter must be a mapping");
  }
  const data = object(parsed);
  const metadata = object(data.metadata);
  const explicit = metadata["opencode/autoinvoke"];
  const autoInvoke =
    typeof explicit === "boolean" ? explicit : data["disable-model-invocation"] === true ? false : true;
  return {
    data,
    name: typeof data.name === "string" ? data.name.trim() : "",
    description: typeof data.description === "string" ? data.description.trim() : "",
    content: rest.slice(closing.index + closing[0].length),
    autoInvoke,
  };
}

export function serializeSkill(input: SkillInput, existing?: string): string {
  const current = existing === undefined ? undefined : parseSkill(existing);
  const data: Record<string, unknown> = { ...current?.data };
  if (input.name.trim()) data.name = input.name.trim();
  else delete data.name;
  if (input.description.trim()) data.description = input.description.trim();
  else delete data.description;
  const metadata = { ...object(data.metadata), "opencode/autoinvoke": input.autoInvoke };
  data.metadata = metadata;
  const frontmatter = YAML.stringify(data, null, 2).trimEnd();
  return `---\n${frontmatter}\n---\n\n${input.content}`;
}

export function skillKey(connectionId: string, location: string): string {
  return createHash("sha256").update(`${connectionId}\0${location}`).digest("hex").slice(0, 32);
}

function normalizedLocation(location: string): string {
  if (/^https?:\/\//i.test(location)) return location;
  return resolve(location);
}

function lexicalInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function idAt(location: string, fallback: string): string {
  if (/^https?:\/\//i.test(location)) {
    try {
      const path = new URL(location).pathname;
      const file = basename(path);
      return file.toLowerCase() === "skill.md" ? basename(dirname(path)) : basename(file, extname(file));
    } catch {
      return fallback;
    }
  }
  const file = basename(location);
  return file === "SKILL.md" ? basename(dirname(location)) : basename(file, extname(file)) || fallback;
}

function readonlyFor(source: SkillSource, local: boolean): SkillReadonlyReason {
  if (!local) return "remote";
  if (source === "claude" || source === "agents") return "compatibility";
  if (source === "builtin" || source === "console") return "builtin";
  return "custom";
}

function sourceAt(location: string, roots: ManagedRoot[], workspace: string, local: boolean) {
  for (const root of roots) {
    if (lexicalInside(root.root, location)) {
      return { ...root, readonlyReason: root.writable ? undefined : ("remote" as const) };
    }
  }
  let source: SkillSource = "unknown";
  if (/^https?:\/\//i.test(location)) source = "http";
  else if (/^embedded:/i.test(location)) source = "builtin";
  else if (/^console:/i.test(location)) source = "console";
  else if (/[\\/]\.claude[\\/]skills[\\/]/.test(location)) source = "claude";
  else if (/[\\/]\.agents[\\/]skills[\\/]/.test(location)) source = "agents";
  else source = "custom";
  const scope = lexicalInside(workspace, location)
    ? ("project" as const)
    : source === "claude" || source === "agents"
      ? ("global" as const)
      : ("other" as const);
  return {
    source,
    scope,
    writable: false,
    readonlyReason: readonlyFor(source, local),
  };
}

function supportingFiles(base: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || files.length >= 100) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && !(dir === base && entry.name === "SKILL.md")) {
        files.push(relative(base, path));
      }
    }
  };
  try {
    visit(base, 0);
  } catch {
    return files;
  }
  return files.sort();
}

function readRecord(
  file: string,
  directoryForm: boolean,
  root: ManagedRoot,
  connectionId: string,
): SkillRecord {
  const id = directoryForm ? basename(dirname(file)) : basename(file, ".md");
  const location = resolve(file);
  const base = directoryForm ? dirname(file) : "";
  let parsed: ParsedSkill = { data: {}, name: "", description: "", content: "", autoInvoke: true };
  let error: string | undefined;
  try {
    if (statSync(file).size > MAX_SKILL_BYTES) throw new Error(`skill exceeds ${MAX_SKILL_BYTES} bytes`);
    parsed = parseSkill(readFileSync(file, "utf8"));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    key: skillKey(connectionId, location),
    id,
    name: parsed.name || id,
    description: parsed.description,
    content: parsed.content,
    autoInvoke: parsed.autoInvoke,
    location,
    source: root.source,
    scope: root.scope,
    status: "inactive",
    writable: root.writable,
    ...(root.writable ? {} : { readonlyReason: "remote" as const }),
    directoryForm,
    files: base ? supportingFiles(base) : [],
    ...(error ? { error } : {}),
    managedRoot: root.root,
  };
}

function scanRoot(root: ManagedRoot, connectionId: string): SkillRecord[] {
  const records: SkillRecord[] = [];
  const read = (file: string, directoryForm: boolean) => {
    records.push(readRecord(file, directoryForm, root, connectionId));
  };
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || records.length >= 1000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const definition = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (definition) {
      read(join(dir, definition.name), true);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (depth === 0 && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        read(path, false);
      }
    }
  };
  visit(root.root, 0);
  return records;
}

function activeRecord(
  active: ActiveSkill,
  roots: ManagedRoot[],
  workspace: string,
  connectionId: string,
  local: boolean,
): SkillRecord {
  const location = normalizedLocation(active.location);
  const at = sourceAt(location, roots, workspace, local);
  let parsed: ParsedSkill;
  try {
    parsed = parseSkill(active.content);
  } catch {
    parsed = { data: {}, name: "", description: "", content: active.content, autoInvoke: true };
  }
  const id = idAt(location, active.name);
  let symlink = false;
  if (local && "root" in at) {
    try {
      symlink = lstatSync(location).isSymbolicLink();
    } catch {
      symlink = false;
    }
  }
  const writable = "root" in at && at.writable && !symlink;
  return {
    key: skillKey(connectionId, location),
    id,
    name: parsed.name || active.name || id,
    description: parsed.description || active.description || "",
    content: parsed.content,
    autoInvoke: parsed.autoInvoke,
    location,
    source: at.source,
    scope: at.scope,
    status: "active",
    writable,
    ...(!writable ? { readonlyReason: symlink ? ("symlink" as const) : at.readonlyReason } : {}),
    directoryForm: basename(location) === "SKILL.md",
    files: [],
    ...("root" in at ? { managedRoot: at.root } : {}),
  };
}

export function listSkills(opts: {
  connectionId: string;
  workspace: string;
  active: ActiveSkill[];
  roots: ManagedRoot[];
  local: boolean;
}): SkillRecord[] {
  const active = opts.active.map((item) => activeRecord(item, opts.roots, opts.workspace, opts.connectionId, opts.local));
  const byLocation = new Map(active.map((item) => [item.location, item]));
  const byId = new Map(active.map((item) => [item.id, item]));
  const records: SkillRecord[] = [];
  const scannedLocations = new Set<string>();
  if (!opts.local) return active;
  for (const root of opts.roots) {
    for (const record of scanRoot(root, opts.connectionId)) {
      const current = byLocation.get(record.location);
      if (current) {
        record.status = "active";
        record.name = record.error ? current.name : record.name;
        record.description = record.error ? current.description : record.description;
        record.content = record.error ? current.content : record.content;
      } else if (byId.has(record.id)) {
        record.status = "overridden";
      }
      records.push(record);
      scannedLocations.add(record.location);
    }
  }
  records.push(...active.filter((item) => !scannedLocations.has(item.location)));
  return records.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id) || a.location.localeCompare(b.location),
  );
}

export function publicSkill(record: SkillRecord) {
  const { managedRoot: _managedRoot, ...skill } = record;
  return skill;
}

function safeExisting(record: SkillRecord): string {
  if (!record.writable || !record.managedRoot || !pathInside(record.managedRoot, record.location)) {
    throw new SkillError("skill is read-only", 403, "skill_readonly");
  }
  if (lstatSync(record.location).isSymbolicLink()) {
    throw new SkillError("symbolic links are not writable", 403, "skill_symlink");
  }
  return record.location;
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function createSkill(root: ManagedRoot, id: string, input: SkillInput): string {
  if (!root.writable) throw new SkillError("remote skills are read-only", 403, "skill_readonly");
  if (!SKILL_ID.test(id) || id.length > 64) throw new SkillError("invalid skill id", 400, "skill_id");
  if (Buffer.byteLength(serializeSkill(input)) > MAX_SKILL_BYTES) {
    throw new SkillError("skill is too large", 413, "skill_size");
  }
  mkdirSync(root.root, { recursive: true });
  const directory = join(root.root, id);
  if (!pathInside(canonical(root.root), canonical(directory)) || dirname(directory) !== resolve(root.root)) {
    throw new SkillError("skill must stay inside its managed root", 400, "skill_path");
  }
  try {
    mkdirSync(directory);
  } catch (cause) {
    if ((cause as { code?: string }).code === "EEXIST") {
      throw new SkillError("skill id already exists", 409, "skill_exists");
    }
    throw cause;
  }
  atomicWrite(join(directory, "SKILL.md"), serializeSkill(input));
  return join(directory, "SKILL.md");
}

export function updateSkill(record: SkillRecord, input: SkillInput): void {
  const file = safeExisting(record);
  const next = serializeSkill(input, readFileSync(file, "utf8"));
  if (Buffer.byteLength(next) > MAX_SKILL_BYTES) throw new SkillError("skill is too large", 413, "skill_size");
  atomicWrite(file, next);
}

export function deleteSkill(record: SkillRecord): void {
  const file = safeExisting(record);
  if (!record.directoryForm) {
    unlinkSync(file);
    return;
  }
  const directory = dirname(file);
  if (!record.managedRoot || !pathInside(record.managedRoot, directory) || resolve(directory) === resolve(record.managedRoot)) {
    throw new SkillError("skill directory is outside its managed root", 403, "skill_path");
  }
  rmSync(directory, { recursive: true });
}
