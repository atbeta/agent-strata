import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkill,
  deleteSkill,
  listSkills,
  parseSkill,
  publicSkill,
  serializeSkill,
  updateSkill,
  type ManagedRoot,
} from "../src/skills";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function temp(): string {
  dir = mkdtempSync(join(tmpdir(), "strata-skills-"));
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const input = { name: "Release", description: "Ship a release", content: "Read the policy.\n", autoInvoke: true };

describe("skill documents", () => {
  test("frontmatter, body, aliases and automatic invocation are read", () => {
    const parsed = parseSkill(
      "---\r\nname: Git Release\ndescription: Prepare a release\nmetadata:\r\n  opencode/autoinvoke: false\r\n---\r\n\r\nDo it.\r\n",
    );
    expect(parsed.name).toBe("Git Release");
    expect(parsed.description).toBe("Prepare a release");
    expect(parsed.content).toBe("\r\nDo it.\r\n");
    expect(parsed.autoInvoke).toBe(false);
    expect(parseSkill("plain markdown").content).toBe("plain markdown");
  });

  test("editing preserves unrelated fields and the explicit setting wins over the compatibility field", () => {
    const original = serializeSkill(input);
    const next = serializeSkill(
      { ...input, name: "Release carefully", autoInvoke: false },
      original.replace("metadata:", "license: MIT\ndisable-model-invocation: true\nmetadata:"),
    );
    expect(next).toContain("license: MIT");
    expect(next).toContain("disable-model-invocation: true");
    expect(next).toContain("opencode/autoinvoke: false");
    expect(parseSkill(next).autoInvoke).toBe(false);
    expect(parseSkill(next).name).toBe("Release carefully");
  });
});

describe("skill discovery and files", () => {
  test("managed scans show active, overridden and inactive entries with path-derived ids", () => {
    const root = temp();
    const global: ManagedRoot = {
      root: join(root, "config", "skills"),
      source: "opencode-global",
      scope: "global",
      writable: true,
    };
    const workspace = join(root, "repo");
    const project: ManagedRoot = {
      root: join(workspace, ".opencode", "skills"),
      source: "opencode-project",
      scope: "project",
      writable: true,
    };
    write(join(global.root, "release", "SKILL.md"), serializeSkill(input));
    write(join(global.root, "flat.md"), "Inactive body");
    const projectFile = join(project.root, "release", "SKILL.md");
    write(projectFile, serializeSkill({ ...input, name: "Project Release" }));
    const skills = listSkills({
      connectionId: "conn",
      workspace,
      roots: [global, project],
      local: true,
      active: [{ name: "Project Release", location: projectFile, content: "Project body" }],
    });
    expect(skills.find((skill) => skill.location === join(global.root, "release", "SKILL.md"))?.status).toBe(
      "overridden",
    );
    expect(skills.find((skill) => skill.location === projectFile)).toMatchObject({
      id: "release",
      name: "Project Release",
      status: "active",
      writable: true,
    });
    expect(skills.find((skill) => skill.id === "flat")).toMatchObject({ status: "inactive", directoryForm: false });
    expect(skills.every((skill) => skill.key.length === 32)).toBe(true);
    expect(Object.keys(publicSkill(skills[0]!))).not.toContain("managedRoot");
  });

  test("Agents and Claude skills outside the workspace are global, not other", () => {
    const root = temp();
    const workspace = join(root, "repo");
    const agents = join(root, "home", ".agents", "skills", "shared", "SKILL.md");
    const claude = join(root, "home", ".claude", "skills", "review", "SKILL.md");
    const project = join(workspace, ".agents", "skills", "local", "SKILL.md");
    const custom = join(root, "elsewhere", "custom.md");
    const skills = listSkills({
      connectionId: "conn",
      workspace,
      roots: [],
      local: true,
      active: [
        { name: "Agents Global", location: agents, content: "Agents" },
        { name: "Claude Global", location: claude, content: "Claude" },
        { name: "Agents Project", location: project, content: "Project" },
        { name: "Custom", location: custom, content: "Custom" },
      ],
    });

    expect(skills.find((skill) => skill.location === agents)).toMatchObject({ source: "agents", scope: "global" });
    expect(skills.find((skill) => skill.location === claude)).toMatchObject({ source: "claude", scope: "global" });
    expect(skills.find((skill) => skill.location === project)).toMatchObject({ source: "agents", scope: "project" });
    expect(skills.find((skill) => skill.location === custom)).toMatchObject({ source: "custom", scope: "other" });
  });

  test("create, edit and delete stay in a managed root and directory deletion includes support files", () => {
    const root = temp();
    const managed: ManagedRoot = {
      root: join(root, "skills"),
      source: "opencode-project",
      scope: "project",
      writable: true,
    };
    expect(() => createSkill(managed, "../escape", input)).toThrow("invalid skill id");
    expect(() => createSkill(managed, "Bad_ID", input)).toThrow("invalid skill id");
    const file = createSkill(managed, "release", input);
    expect(file).toBe(join(managed.root, "release", "SKILL.md"));
    expect(() => createSkill(managed, "release", input)).toThrow("skill id already exists");
    write(join(managed.root, "release", "scripts", "release.ts"), "console.log('release')");
    let record = listSkills({
      connectionId: "conn",
      workspace: root,
      roots: [managed],
      local: true,
      active: [{ name: "Release", location: file, content: "Read the policy.\n" }],
    }).find((skill) => skill.location === file)!;
    expect(record.files).toEqual(["scripts/release.ts"]);
    updateSkill(record, { ...input, description: "Updated", autoInvoke: false });
    expect(readFileSync(file, "utf8")).toContain("description: Updated");
    record = listSkills({
      connectionId: "conn",
      workspace: root,
      roots: [managed],
      local: true,
      active: [],
    }).find((skill) => skill.location === file)!;
    expect(record.status).toBe("inactive");
    expect(record.autoInvoke).toBe(false);
    deleteSkill(record);
    expect(readdirSync(managed.root)).toEqual([]);
    expect(readdirSync(root).some((name) => name.includes(".tmp"))).toBe(false);
  });

  test("a symlinked definition is never writable", () => {
    const root = temp();
    const managed: ManagedRoot = {
      root: join(root, "skills"),
      source: "opencode-project",
      scope: "project",
      writable: true,
    };
    const outside = join(root, "outside.md");
    write(outside, "outside");
    mkdirSync(managed.root, { recursive: true });
    const linked = join(managed.root, "linked.md");
    symlinkSync(outside, linked);
    const record = listSkills({
      connectionId: "conn",
      workspace: root,
      roots: [managed],
      local: true,
      active: [{ name: "linked", location: linked, content: "outside" }],
    }).find((skill) => skill.id === "linked")!;
    expect(record.writable).toBe(false);
    expect(record.readonlyReason).toBe("symlink");
    expect(() => updateSkill(record, input)).toThrow("read-only");
  });
});
