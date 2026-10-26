import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableBackupName,
  backupName,
  fileInfo,
  listBackups,
  listLegacy,
  maintenanceDirs,
  safeName,
} from "../src/maintenance";

describe("maintenance files", () => {
  test("a stored name cannot carry a path", () => {
    expect(safeName("events-1.db")).toBe(true);
    expect(safeName("../events.db")).toBe(false);
    expect(safeName("sub/events.db")).toBe(false);
    expect(safeName("..")).toBe(false);
    expect(safeName("")).toBe(false);
  });

  test("managed backups are listed newest first, legacy snapshots by size", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-maint-"));
    try {
      mkdirSync(join(dir, "backups"));
      writeFileSync(join(dir, "backups", "events-b.db"), "bbbb");
      writeFileSync(join(dir, "backups", "events-a.db"), "aa");
      writeFileSync(join(dir, "events.db.bak-20260101-0000"), "x".repeat(20));
      writeFileSync(join(dir, "events.db-wal.bak-20260101-0000"), "x".repeat(10));
      writeFileSync(join(dir, "events.db"), "live");

      expect(listBackups(dir).map((b) => b.name).sort()).toEqual(["events-a.db", "events-b.db"]);
      expect(listBackups(dir).every((b) => b.bytes > 0)).toBe(true);
      expect(listLegacy(dir).map((f) => f.name)).toEqual([
        "events.db.bak-20260101-0000",
        "events.db-wal.bak-20260101-0000",
      ]);
      expect(listLegacy(dir)[0]!.bytes).toBe(20);
      expect(fileInfo(join(dir, "missing"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the backup name is stable for a given second and avoids collisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-maint-"));
    try {
      const now = new Date(2026, 9, 21, 23, 45, 6);
      expect(backupName(now)).toBe("events-20261021-234506.db");
      mkdirSync(join(dir, "backups"));
      writeFileSync(join(dir, "backups", "events-20261021-234506.db"), "taken");
      expect(availableBackupName(dir, now)).toBe("events-20261021-234506-1.db");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maintenance dirs follow the database and fall back to the desktop dir", () => {
    const profile = join(tmpdir(), "profile");
    const desktop = join(tmpdir(), "desktop");
    expect(maintenanceDirs(join(profile, "events.db"), desktop)).toEqual({
      dir: profile,
      dbPath: join(profile, "events.db"),
      backupDir: join(profile, "backups"),
    });
    expect(maintenanceDirs(":memory:", desktop)).toEqual({
      dir: desktop,
      dbPath: null,
      backupDir: join(desktop, "backups"),
    });
  });
});
