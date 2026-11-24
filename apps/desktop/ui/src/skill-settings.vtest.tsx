import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { SKILL_REFRESH_MS, SkillSettings } from "./skill-settings";
import { t } from "./i18n";
import type { ConnectionsCtl } from "./use-connections";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
  window.location.hash = "";
});

test("the skills page mounts, updates a skill, and keeps the editor stable while creating one", async () => {
  const workspace = "/repo";
  const location = "/repo/.opencode/skills/release/SKILL.md";
  const writes: { method: string; url: string; body: unknown }[] = [];
  let created = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" || init?.method === "POST") {
      writes.push({ method: init.method, url, body: JSON.parse(String(init.body)) });
      if (init.method === "POST") created = true;
      return Promise.resolve(Response.json({ ok: true, reloaded: true }));
    }
    if (url === "/api/skills?connection=conn") {
      return Promise.resolve(Response.json({
        workspaces: [{ directory: workspace, name: "Repo" }],
        connection: { id: "conn", local: true },
        globalAvailable: true,
      }));
    }
    if (url.startsWith("/api/skills?")) {
      return Promise.resolve(Response.json({
        workspace,
        connection: { id: "conn", local: true },
        globalAvailable: true,
        skills: [
          {
            key: "0123456789abcdef0123456789abcdef",
            id: "release",
            name: "Release",
            description: "Prepare a release",
            content: "Read the policy.",
            autoInvoke: true,
            location,
            source: "opencode-project",
            scope: "project",
            status: "active",
            writable: true,
            directoryForm: true,
            files: ["references/policy.md"],
          },
          ...(created ? [{
            key: "fedcba9876543210fedcba9876543210",
            id: "second-skill",
            name: "Second Skill",
            description: "A second skill",
            content: "Second body.",
            autoInvoke: true,
            location: "/repo/.opencode/skills/second-skill/SKILL.md",
            source: "opencode-project",
            scope: "project",
            status: "inactive",
            writable: true,
            directoryForm: true,
            files: [],
          }] : []),
        ],
      }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const conns = {
    conns: {
      latest: {
        connections: [{
          id: "conn",
          backend: "opencode",
          baseUrl: "http://127.0.0.1:4096",
          directory: workspace,
          capabilities: { extension: "opencode" },
        }],
      },
    },
  } as unknown as ConnectionsCtl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const changed = vi.fn();
  const [skillId, setSkillId] = createSignal<string>();
  window.addEventListener("strata-skills-changed", changed);
  dispose = render(() => <SkillSettings conns={conns} skillId={skillId()} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain("Release"));
  const row = [...host.querySelectorAll<HTMLButtonElement>("nav[aria-label] button")].find((button) =>
    button.textContent?.includes("Release"),
  );
  expect(row).toBeTruthy();
  row!.click();
  expect(window.location.hash).toBe("#/settings/skills/0123456789abcdef0123456789abcdef");
  setSkillId("0123456789abcdef0123456789abcdef");
  const toggle = await vi.waitFor(() => {
    const value = host.querySelector<HTMLButtonElement>(
      `[aria-label="${t("skills.autoinvokeFor", { name: "Release" })}"]`,
    );
    expect(value).toBeTruthy();
    return value!;
  });
  toggle.click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.url).toContain("/api/skills/0123456789abcdef0123456789abcdef?");
  expect(writes[0]!.body).toMatchObject({ autoInvoke: false, content: "Read the policy." });
  expect(changed).toHaveBeenCalledOnce();

  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));
  button(t("skills.new"))!.click();
  expect(host.textContent).toContain(t("skills.installed"));
  expect(host.querySelector("#skill-content")).toBeTruthy();
  const field = (label: string) => {
    const caption = [...host.querySelectorAll("label")].find((item) => item.textContent === label);
    const input = caption ? document.getElementById(caption.htmlFor) : undefined;
    expect(input).toBeTruthy();
    return input as HTMLInputElement;
  };
  const id = field(t("skills.form.id"));
  id.value = "second-skill";
  id.dispatchEvent(new Event("input", { bubbles: true }));
  expect(field(t("skills.form.id"))).toBe(id);
  const name = field(t("skills.form.name"));
  name.value = "Second Skill";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  expect(field(t("skills.form.name"))).toBe(name);
  button(t("skills.save"))!.click();
  await vi.waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({
    method: "POST",
    body: { id: "second-skill", name: "Second Skill", scope: "project" },
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Second Skill"));
  expect(changed).toHaveBeenCalledTimes(2);
  window.removeEventListener("strata-skills-changed", changed);
});

test("a connection refresh and the list poll keep an open draft", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const workspace = "/repo";
  let lists = 0;
  const writes: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      writes.push({ method: init.method, url, body: JSON.parse(String(init.body)) });
      return Promise.resolve(Response.json({ ok: true, reloaded: true }));
    }
    if (url === "/api/skills?connection=conn") {
      return Promise.resolve(Response.json({
        workspaces: [
          { directory: workspace, name: "Repo" },
          { directory: "/elsewhere", name: "Elsewhere" },
        ],
        connection: { id: "conn", local: true },
        globalAvailable: true,
      }));
    }
    if (url.startsWith("/api/skills?")) {
      lists += 1;
      return Promise.resolve(Response.json({
        workspace,
        connection: { id: "conn", local: true },
        globalAvailable: true,
        skills: [],
      }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const conn = {
    id: "conn",
    backend: "opencode",
    baseUrl: "http://127.0.0.1:4096",
    directory: workspace,
    capabilities: { extension: "opencode" },
  };
  const [snapshot, setSnapshot] = createSignal({ connections: [conn] });
  const conns = {
    conns: {
      get latest() {
        return snapshot();
      },
    },
  } as unknown as ConnectionsCtl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <SkillSettings conns={conns} />, host);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));
  await vi.waitFor(() => expect(button(t("skills.new"))?.disabled).toBe(false));
  button(t("skills.new"))!.click();
  expect(host.querySelector("#skill-content")).toBeTruthy();
  expect(host.textContent).toContain(t("skills.installed"));

  setSnapshot({ connections: [{ ...conn, directory: "/elsewhere" }] });
  expect(host.querySelector("#skill-content")).toBeTruthy();
  expect(host.textContent).toContain(t("skills.installed"));

  const before = lists;
  await vi.advanceTimersByTimeAsync(SKILL_REFRESH_MS);
  await vi.waitFor(() => expect(lists).toBeGreaterThan(before));
  expect(host.querySelector("#skill-content")).toBeTruthy();
  expect(host.textContent).toContain(t("skills.installed"));

  const field = (label: string) => {
    const caption = [...host.querySelectorAll("label")].find((item) => item.textContent === label);
    const input = caption ? document.getElementById(caption.htmlFor) : undefined;
    expect(input).toBeTruthy();
    return input as HTMLInputElement;
  };
  const id = field(t("skills.form.id"));
  id.value = "kept-skill";
  id.dispatchEvent(new Event("input", { bubbles: true }));
  button(t("skills.save"))!.click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body).toMatchObject({ id: "kept-skill", workspace, scope: "project" });
});


test("the compact directory filters scopes, opens details, and guards an unsaved draft", async () => {
  const workspace = "/repo";
  const globalKey = "global-skill-key";
  const projectKey = "project-skill-key";
  const skills = [
    {
      key: globalKey,
      id: "global-skill",
      name: "Global Skill",
      description: "A global description that belongs only in detail",
      content: "Global instructions",
      autoInvoke: true,
      location: "/global/SKILL.md",
      source: "opencode-global",
      scope: "global",
      status: "active",
      writable: true,
      directoryForm: false,
      files: [],
    },
    {
      key: "agents-global-skill-key",
      id: "agents-global-skill",
      name: "Agents Global Skill",
      description: "A global compatibility skill",
      content: "Agents global instructions",
      autoInvoke: true,
      location: "/home/.agents/skills/shared/SKILL.md",
      source: "agents",
      scope: "global",
      status: "active",
      writable: false,
      directoryForm: true,
      files: [],
    },
    {
      key: projectKey,
      id: "project-skill",
      name: "Project Skill",
      description: "A project description that belongs only in detail",
      content: "Project instructions",
      autoInvoke: true,
      location: "/repo/.opencode/skills/project/SKILL.md",
      source: "opencode-project",
      scope: "project",
      status: "active",
      writable: true,
      directoryForm: true,
      files: [],
    },
  ];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/skills?connection=conn") {
      return Promise.resolve(Response.json({
        workspaces: [{ directory: workspace, name: "Repo" }],
        connection: { id: "conn", local: true },
        globalAvailable: true,
      }));
    }
    if (url.startsWith("/api/skills?")) {
      return Promise.resolve(Response.json({
        workspace,
        connection: { id: "conn", local: true },
        globalAvailable: true,
        skills,
      }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const conns = {
    conns: {
      latest: {
        connections: [{
          id: "conn",
          backend: "opencode",
          baseUrl: "http://127.0.0.1:4096",
          directory: workspace,
          capabilities: { extension: "opencode" },
        }],
      },
    },
  } as unknown as ConnectionsCtl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const [skillId, setSkillId] = createSignal<string>();
  dispose = render(() => <SkillSettings conns={conns} skillId={skillId()} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain("Global Skill"));
  expect(host.querySelector("nav[aria-label]")?.textContent).not.toContain("belongs only in detail");
  expect(host.textContent).toContain("A global description that belongs only in detail");
  expect(host.textContent).not.toContain("A project description that belongs only in detail");

  const globalFilter = [...host.querySelectorAll<HTMLButtonElement>("button[role='radio']")].find(
    (item) => item.textContent === t("skills.scope.global"),
  );
  globalFilter!.click();
  expect(host.textContent).toContain("Global Skill");
  expect(host.querySelector("nav[aria-label]")?.textContent).toContain("Agents Global Skill");
  expect(host.textContent).not.toContain("Project Skill");
  const globalRow = [...host.querySelectorAll<HTMLButtonElement>("nav[aria-label] button")].find(
    (item) => item.textContent?.includes("Global Skill"),
  );
  globalRow!.click();
  expect(window.location.hash).toBe(`#/settings/skills/${globalKey}`);
  setSkillId(globalKey);
  await vi.waitFor(() => expect(host.textContent).toContain("A global description that belongs only in detail"));
  expect(host.textContent).toContain("Global instructions");

  const allFilter = [...host.querySelectorAll<HTMLButtonElement>("button[role='radio']")].find(
    (item) => item.textContent === t("skills.filter.all"),
  );
  allFilter!.click();
  const edit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === t("skills.edit"),
  );
  edit!.click();
  const nameLabel = [...host.querySelectorAll("label")].find(
    (item) => item.textContent === t("skills.form.name"),
  );
  const nameInput = document.getElementById(nameLabel!.htmlFor) as HTMLInputElement;
  nameInput.value = "Changed name";
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  const projectRow = [...host.querySelectorAll<HTMLButtonElement>("nav[aria-label] button")].find(
    (item) => item.textContent?.includes("Project Skill"),
  );
  projectRow!.click();
  const dialog = await vi.waitFor(() => {
    const value = document.body.querySelector(`[aria-label='${t("skills.unsaved.title")}']`);
    expect(value).toBeTruthy();
    return value!;
  });
  expect(window.location.hash).toBe(`#/settings/skills/${globalKey}`);
  const cancel = [...dialog.querySelectorAll("button")].find((item) => item.textContent === t("confirm.cancel"));
  cancel!.click();
  projectRow!.click();
  const confirmDialog = document.body.querySelector(`[aria-label='${t("skills.unsaved.title")}']`)!;
  const discard = [...confirmDialog.querySelectorAll("button")].find(
    (item) => item.textContent === t("skills.unsaved.discard"),
  );
  discard!.click();
  expect(window.location.hash).toBe(`#/settings/skills/${projectKey}`);
});
