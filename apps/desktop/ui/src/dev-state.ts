import { createMemo, createSignal, type Accessor, type Setter } from "solid-js";
import { t } from "./i18n";
import type { DevLogLine, DevProcess } from "./api";

/**
 * Where a background command is in its life.
 *
 * The table outlives the process, so "not running" is not one thing. A command
 * that was stopped is stopped; one whose process disappeared without anyone
 * stopping it is lost; one the service found still running after it died is an
 * orphan, and the only honest thing to say about it is that it was there and
 * was cleaned up. Folding all three into "stopped" would hide the two that
 * something is still wrong about.
 */

/**
 * Whether a process is still up.
 *
 * The state is asked first when it is there: a record whose process is gone is
 * not running, however its exit code reads.
 */
export function devRunning(process: DevProcess): boolean {
  if (process.state !== undefined) return process.state === "running";
  return process.exit_code === null;
}

/**
 * What the row says about a process, in the order that matters.
 *
 * A process that never started has no exit code and no uptime: it has an error,
 * and that error is the whole story. A stopped one is not "exited 143" to a
 * reader who pressed the button — it is stopped.
 */
export function stateLabel(process: DevProcess): string {
  if (process.state === "lost") return t("dev.lost");
  if (process.state === "orphaned") return t("dev.orphaned");
  if (process.error && process.exit_code !== 0) return t("dev.failed");
  if (devRunning(process)) return t("dev.running");
  if (process.stopped) return t("dev.stopped");
  return t("dev.exited", { code: process.exit_code ?? 0 });
}

export function stateClass(process: DevProcess): string {
  if (process.state === "lost" || process.state === "orphaned") return "text-muted-foreground";
  if (process.error && process.exit_code !== 0) return "text-destructive";
  if (devRunning(process)) return "text-status-active";
  if (process.stopped) return "text-muted-foreground";
  return "text-status-error";
}

export function dotClass(process: DevProcess): string {
  if (process.state === "lost" || process.state === "orphaned") return "bg-muted-foreground/50";
  if (process.error && process.exit_code !== 0) return "bg-destructive";
  if (devRunning(process)) return "bg-status-active";
  if (process.stopped) return "bg-muted-foreground/50";
  return "bg-status-error";
}

export interface StableDevRow {
  id: string;
  process: Accessor<DevProcess>;
}

type CachedDevRow = StableDevRow & { update: Setter<DevProcess> };

export function createDevRowCache(): (processes: DevProcess[]) => StableDevRow[] {
  const cache = new Map<string, CachedDevRow>();
  return (next) => {
    const retained = new Set(next.map((process) => process.id));
    const rows = next.map((process) => {
      let row = cache.get(process.id);
      if (!row) {
        const [current, update] = createSignal(process);
        row = { id: process.id, process: current, update };
        cache.set(process.id, row);
      } else {
        row.update(process);
      }
      return row;
    });
    for (const id of cache.keys()) {
      if (!retained.has(id)) cache.delete(id);
    }
    return rows;
  };
}

export function stableDevRows(source: Accessor<DevProcess[]>): Accessor<StableDevRow[]> {
  const update = createDevRowCache();
  return createMemo(() => update(source()));
}

export function devLogLineClass(_stream: DevLogLine["stream"]): string {
  return "text-foreground/80";
}
