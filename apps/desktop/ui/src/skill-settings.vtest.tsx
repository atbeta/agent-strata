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
  window.addEventListener("strata-skills-changed", changed);
  dispose = render(() => <SkillSettings conns={conns} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain("Release"));
  const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
    button.textContent?.includes("Release"),
  );
  expect(row).toBeTruthy();
  row!.click();
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
  expect(host.textContent).not.toContain(t("skills.installed"));
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
  expect(host.textContent).not.toContain(t("skills.installed"));

  setSnapshot({ connections: [{ ...conn, directory: "/elsewhere" }] });
  expect(host.querySelector("#skill-content")).toBeTruthy();
  expect(host.textContent).not.toContain(t("skills.installed"));

  const before = lists;
  await vi.advanceTimersByTimeAsync(SKILL_REFRESH_MS);
  await vi.waitFor(() => expect(lists).toBeGreaterThan(before));
  expect(host.querySelector("#skill-content")).toBeTruthy();
  expect(host.textContent).not.toContain(t("skills.installed"));

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
