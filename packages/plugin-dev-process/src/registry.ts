import { readFileSync, writeFileSync } from "node:fs";
import type { DevLost, PersistedProcess } from "./types";

/**
 * The table as the last run left it.
 *
 * Both shapes are read. The file used to be a bare array of the live
 * processes, and one written by an older build is still on disk after an
 * upgrade — and it is exactly the file that tells the next run which
 * processes to clean up.
 */
export function readRecords(file: string, now: () => number = Date.now): PersistedProcess[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return decodeRecords(raw, now);
}

export function decodeRecords(raw: string, now: () => number = Date.now): PersistedProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { processes?: unknown }).processes)
      ? (parsed as { processes: unknown[] }).processes
      : [];
  const records: PersistedProcess[] = [];
  let index = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<PersistedProcess>;
    index += 1;
    // A record that cannot be named is still a record: the pid in it is
    // still running, and skipping it would leak the very process the file
    // exists to describe.
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `dev_unknown_${index}`;
    records.push({
      id,
      session_id: typeof item.session_id === "string" ? item.session_id : "",
      command: String(item.command ?? ""),
      cwd: String(item.cwd ?? ""),
      pid: typeof item.pid === "number" ? item.pid : undefined,
      started_at: typeof item.started_at === "number" ? item.started_at : now(),
      port: typeof item.port === "number" ? item.port : undefined,
      // An older file has no state: a record in it was live when it was
      // written, so it is either running still or lost.
      state: item.state ?? "running",
      exit_code: typeof item.exit_code === "number" ? item.exit_code : undefined,
      stopped_at: typeof item.stopped_at === "number" ? item.stopped_at : undefined,
      lost: parseLost(item.lost),
    });
  }
  return records;
}

export function writeRecords(file: string, processes: PersistedProcess[]): void {
  writeFileSync(file, JSON.stringify({ version: 2, processes }));
}

function parseLost(value: unknown): DevLost | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { process?: unknown; port_held?: unknown; port_holders?: unknown };
  if (row.process !== "gone" && row.process !== "reused") return undefined;
  const lost: DevLost = { process: row.process };
  if (typeof row.port_held === "boolean") lost.port_held = row.port_held;
  if (Array.isArray(row.port_holders)) {
    const pids = row.port_holders.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0);
    if (pids.length > 0) lost.port_holders = pids;
  }
  return lost;
}
