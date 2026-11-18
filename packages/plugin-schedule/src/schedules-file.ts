// schedules.json — the plugin's whole durable state.
//
// The store only holds backend-derived rows and a few local-only facts; a
// schedule is neither, so it lives in the plugin's own dataDir like the dev
// plugin's pid table. Writes go through a temp file + rename so a crash
// mid-write cannot leave half a JSON document, and the file is mode 0600:
// a prompt scheduled against a backend is not public reading.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Schedule } from "./model";

export class SchedulesFile {
  constructor(private readonly path: string) {}

  load(): Schedule[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { schedules?: Schedule[] };
      return Array.isArray(raw.schedules) ? raw.schedules : [];
    } catch {
      // A corrupt file is renamed, not thrown away by hand and not kept in
      // the way: the next save writes a clean one beside it.
      try {
        renameSync(this.path, `${this.path}.bad-${Date.now()}`);
      } catch {
        // cannot even move it — leave it; reads stay empty rather than crash
      }
      return [];
    }
  }

  save(schedules: Schedule[]): void {
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify({ schedules }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Read-modify-write in one place so every caller shares the file's rules. */
  mutate<T>(fn: (schedules: Schedule[]) => T): T {
    const schedules = this.load();
    const out = fn(schedules);
    this.save(schedules);
    return out;
  }
}
