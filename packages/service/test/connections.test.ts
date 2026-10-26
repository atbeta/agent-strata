import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionMemory, endpointOf, looksEmbedded } from "../src/connections";

/** The shape the shell gives the server it starts. */
const embedded = (port: number) => ({
  baseUrl: `http://127.0.0.1:${port}`,
  username: "opencode",
  password: "yachwVpceU13FftYteC9pU7Hq448RciEEgmflAWueNI",
});

const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `strata-${name}-`));

const list = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as {
    baseUrl?: string;
    placement?: string;
    username?: string;
    password?: string;
    credentials?: string;
  }[];

describe("connection memory", () => {
  test("the embedded server keeps one slot, whatever port it takes", () => {
    const dir = tempDir("embed-slot");
    const memory = connectionMemory(join(dir, "events.db"));

    memory.remember({ ...embedded(53507), placement: "embed" });
    memory.remember({ ...embedded(64091), placement: "embed" });

    const saved = list(dir);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.baseUrl).toBe("http://127.0.0.1:64091");
    expect(saved[0]?.placement).toBe("embed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an embedded server leaves the addresses of other backends alone", () => {
    const dir = tempDir("embed-others");
    const memory = connectionMemory(join(dir, "events.db"));

    memory.remember({ baseUrl: "http://127.0.0.1:4096", name: "mine" });
    memory.remember({ backend: "acp", command: "opencode", args: ["acp"] });
    memory.remember({ ...embedded(53507), placement: "embed" });

    const saved = list(dir);
    expect(saved.map((c) => c.baseUrl ?? "acp://opencode acp")).toEqual([
      "http://127.0.0.1:4096",
      "acp://opencode acp",
      "http://127.0.0.1:53507",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the addresses the app marked as its own are dropped when they are stale", () => {
    const dir = tempDir("embed-prune");
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([
        { ...embedded(53507), placement: "embed" },
        { ...embedded(51800), placement: "embed" },
        { baseUrl: "http://127.0.0.1:4096" },
        { backend: "acp", command: "opencode", args: ["acp"] },
      ]) + "\n",
    );
    const memory = connectionMemory(join(dir, "events.db"));

    const rest = memory.pruneEmbedded("embed", "http://127.0.0.1:64091");

    expect(rest.map((c) => endpointOf(c))).toEqual([
      "http://127.0.0.1:4096",
      "acp://opencode acp",
    ]);
    expect(list(dir).map((c) => c.baseUrl)).toEqual([
      "http://127.0.0.1:4096",
      undefined,
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address that only looks like ours is left to the answer it gives", () => {
    const dir = tempDir("embed-guess");
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([embedded(53507), { baseUrl: "http://127.0.0.1:4096" }]) + "\n",
    );
    const memory = connectionMemory(join(dir, "events.db"));

    const rest = memory.pruneEmbedded("embed", "http://127.0.0.1:64091");

    // Whether it is a server of the user's is settled by whether it answers,
    // not by the shape of its address.
    expect(rest.map((c) => endpointOf(c))).toEqual([
      "http://127.0.0.1:53507",
      "http://127.0.0.1:4096",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the address the current run owns is kept", () => {
    const dir = tempDir("embed-keep");
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ ...embedded(64091), placement: "embed" }, embedded(53507)]) + "\n",
    );
    const memory = connectionMemory(join(dir, "events.db"));

    const rest = memory.pruneEmbedded("embed", "http://127.0.0.1:64091");

    expect(rest.map((c) => endpointOf(c))).toEqual([
      "http://127.0.0.1:64091",
      "http://127.0.0.1:53507",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address that only looks like ours is not dropped while the app owns no server", () => {
    const dir = tempDir("embed-guess");
    writeFileSync(join(dir, "connections.json"), JSON.stringify([embedded(53507)]) + "\n");
    const memory = connectionMemory(join(dir, "events.db"));

    const rest = memory.pruneEmbedded("external");

    expect(rest.map((c) => endpointOf(c))).toEqual(["http://127.0.0.1:53507"]);
    expect(list(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address the app marked as its own is dropped even in external mode", () => {
    const dir = tempDir("embed-marked");
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ ...embedded(53507), placement: "embed" }, { baseUrl: "http://127.0.0.1:4096" }]) +
        "\n",
    );
    const memory = connectionMemory(join(dir, "events.db"));

    const rest = memory.pruneEmbedded("external");

    expect(rest.map((c) => endpointOf(c))).toEqual(["http://127.0.0.1:4096"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address of ours is recognised by its shape, not only by the marker", () => {
    expect(looksEmbedded(embedded(53507))).toBe(true);
    expect(looksEmbedded({ ...embedded(53507), placement: "embed" })).toBe(false);
    expect(looksEmbedded({ ...embedded(53507), placement: "external" })).toBe(false);
    expect(looksEmbedded({ baseUrl: "http://127.0.0.1:4096" })).toBe(false);
    expect(looksEmbedded({ ...embedded(53507), username: "someone" })).toBe(false);
    expect(looksEmbedded({ ...embedded(53507), password: "short" })).toBe(false);
    expect(looksEmbedded({ ...embedded(53507), baseUrl: "http://192.168.1.10:4096" })).toBe(false);
  });

  test("the embedded server's password is not written down here", () => {
    // The pair is the shell's secret, and the shell keeps it in the status
    // file. A copy here would be a second copy of a secret in a file that
    // has no reason to hold one.
    const dir = tempDir("embed-secret");
    const memory = connectionMemory(join(dir, "events.db"));

    memory.remember({ ...embedded(53507), placement: "embed" });

    const text = readFileSync(join(dir, "connections.json"), "utf8");
    expect(text).not.toContain(embedded(53507).password);
    const saved = list(dir);
    expect(saved[0]?.password).toBeUndefined();
    // What is left is a reference to where the pair can be read.
    expect(saved[0]?.credentials).toBe("opencode-status");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a server of the user's keeps its password, so it can be dialed again", () => {
    const dir = tempDir("external-secret");
    const memory = connectionMemory(join(dir, "events.db"));

    memory.remember({ baseUrl: "http://127.0.0.1:4096", username: "me", password: "hunter2" });

    const saved = list(dir);
    expect(saved[0]?.password).toBe("hunter2");
    expect(saved[0]?.credentials).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the file of remembered addresses is read only by its owner", () => {
    const dir = tempDir("embed-mode");
    const memory = connectionMemory(join(dir, "events.db"));

    memory.remember({ ...embedded(53507), placement: "embed" });

    // A file another account on the machine can read is a secret in the open.
    const mode = statSync(join(dir, "connections.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
