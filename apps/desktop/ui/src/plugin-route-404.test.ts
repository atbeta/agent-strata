import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

/**
 * A plugin that is not running answers 404 on its routes.
 *
 * The session page reads plugin-backed resources. A bare read of an errored
 * Solid resource throws, and the throw leaves the component that owns the
 * memo — which takes the whole session page down and shows the reader
 * 无法连接到本地服务 over a session that was perfectly fine.
 *
 * Every one of those reads must go through `settled`, which reads an errored
 * resource as nothing here. The panes that want to say so read `.error`
 * themselves.
 *
 * This asserts the shape of the reads rather than running them: `bun test`
 * resolves solid-js to its server build, which cannot create a resource, and
 * this is the suite CI runs. The runtime half of the same claim lives in
 * plugin-route-404.vtest.tsx, which mounts the hooks under vitest.
 */

describe("a plugin route that is not there", () => {
  test("the session page reads the dev processes through settled", () => {
    const source = read("dev-processes.ts");
    // The bare read is the defect: it throws and takes the page with it.
    expect(source).not.toContain("(processes() ?? [])");
    expect(source).toContain("settled(processes)");
  });

  test("the background panel reads the dev processes through settled", () => {
    const source = read("background-panel.tsx");
    // Every read of this resource goes through settled: the bare form throws
    // when the dev plugin is not running.
    expect(source).not.toContain("props.processes()");
    expect(source).toContain("settled(props.processes)");
  });

  test("the shell picker reads the terminal shells through settled", () => {
    const source = read("backend-settings.tsx");
    expect(source).not.toContain("shells() ?? []");
    expect(source).not.toContain("shells()!");
    expect(source).toContain("settled(shells)");
  });

  test("the two panes upstream fixed read through settled too", () => {
    // Upstream fixed the same class in use-terminals and use-schedules; the
    // reads there must not drift back to a bare access.
    const terminals = read("use-terminals.ts");
    expect(terminals).not.toContain("(sessions() ?? [])");
    expect(terminals).toContain("settled(sessions)");

    const schedules = read("use-schedules.ts");
    expect(schedules).not.toContain("(data()?");
    expect(schedules).toContain("settled(data)");
  });
});
