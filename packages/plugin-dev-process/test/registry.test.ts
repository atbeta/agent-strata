import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRecords, readRecords, writeRecords } from "../src/registry";

describe("registry codec", () => {
  test("reads the v1 array and supplies the old defaults", () => {
    const records = decodeRecords(JSON.stringify([null, { pid: 42 }]), () => 1234);
    expect(records).toEqual([
      {
        id: "dev_unknown_1",
        session_id: "",
        command: "",
        cwd: "",
        pid: 42,
        started_at: 1234,
        port: undefined,
        state: "running",
        exit_code: undefined,
        stopped_at: undefined,
        lost: undefined,
      },
    ]);
  });

  test("reads v2 stopped and lost records without changing their shape", () => {
    const records = decodeRecords(
      JSON.stringify({
        version: 2,
        processes: [
          {
            id: "dev_lost",
            session_id: "s",
            command: "serve",
            cwd: "/work",
            started_at: 10,
            state: "lost",
            exit_code: 1,
            lost: { process: "reused", port_held: true, port_holders: [7, -1, 8.5, 9] },
          },
        ],
      }),
    );
    expect(records[0]?.state).toBe("lost");
    expect(records[0]?.lost).toEqual({ process: "reused", port_held: true, port_holders: [7, 9] });
  });

  test("writes the v2 envelope synchronously and tolerates unreadable input", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-registry-"));
    const file = join(dir, "processes.json");
    try {
      writeRecords(file, [
        {
          id: "dev_a",
          session_id: "s",
          command: "serve",
          cwd: dir,
          started_at: 10,
          state: "running",
        },
      ]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        version: 2,
        processes: [
          {
            id: "dev_a",
            session_id: "s",
            command: "serve",
            cwd: dir,
            started_at: 10,
            state: "running",
          },
        ],
      });
      expect(readRecords(file)).toHaveLength(1);
      expect(decodeRecords("not json")).toEqual([]);
      expect(decodeRecords("{}")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
