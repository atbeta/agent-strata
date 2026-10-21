import { createResource, createSignal, For, Show } from "solid-js";
import {
  backupMaintenance,
  checkMaintenance,
  cleanMaintenance,
  deleteBackup,
  deleteLegacy,
  optimizeMaintenance,
  readMaintenance,
  type CleanResult,
  type MaintenanceSnapshot,
} from "./maintenance-api";
import { displayTitle } from "./session-title";
import { explain } from "./errors";
import { date, num, stamp, t } from "./i18n";
import { Group } from "./settings-blocks";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { Icon } from "./icons";

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
}

/**
 * The maintenance screen.
 *
 * Two halves of one store, treated differently. The transcript is a cache the
 * backend can give back; permissions, questions, status changes and goals are
 * observations only strata has. Cleaning the first is routine; touching the
 * second is an export-and-confirm decision, so this screen never does it by
 * accident.
 */
export function MaintenanceSettings() {
  const [snapshot, { refetch, mutate }] = createResource(readMaintenance);
  const [busy, setBusy] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [check, setCheck] = createSignal<string[]>();
  const [preview, setPreview] = createSignal<CleanResult>();
  const [cleanNote, setCleanNote] = createSignal("");
  const [days, setDays] = createSignal(30);
  const [daysText, setDaysText] = createSignal("30");
  const [archivedOnly, setArchivedOnly] = createSignal(false);
  // A second press confirms. Native `confirm()` is a browser sheet in a
  // webview and reads as a different application; this keeps the decision on
  // the control the reader is already looking at.
  const [confirming, setConfirming] = createSignal("");
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const confirmAction = (key: string, action: () => void) => {
    if (confirming() !== key) {
      setConfirming(key);
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => setConfirming(""), 5000);
      return;
    }
    clearTimeout(confirmTimer);
    setConfirming("");
    action();
  };


  const db = () => snapshot()?.db;
  const stats = () => db()?.stats;
  const totalBytes = () => {
    const row = db();
    return row ? row.bytes + row.wal_bytes + row.shm_bytes : 0;
  };
  /** The two classes are shares of the stored events, not of the file: SQLite
   *  indexes and page overhead are neither kind of row. */
  const contentBytes = () => {
    const row = stats();
    return row ? row.rebuildable.bytes + row.local.bytes : 0;
  };
  const run = async <T,>(label: string, task: () => Promise<T>, done?: (value: T) => void) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const value = await task();
      done?.(value);
      return value;
    } catch (e) {
      setError(explain(e));
      return undefined;
    } finally {
      setBusy("");
    }
  };
  const showSnapshot = (next: MaintenanceSnapshot) => {
    mutate(next);
  };
  const runCheck = () =>
    void run("check", checkMaintenance, (result) => {
      setCheck(result.results);
    });
  const runOptimize = () =>
    void run("optimize", () => optimizeMaintenance(false), (next) => {
      showSnapshot(next);
      setCheck(undefined);
      setMessage(t("maintenance.optimize.done"));
    });
  const runVacuum = () =>
    void run("vacuum", () => optimizeMaintenance(true), (next) => {
      showSnapshot(next);
      setMessage(t("maintenance.vacuum.done"));
    });
  const runBackup = () =>
    void run("backup", backupMaintenance, (next) => {
      showSnapshot(next);
      setMessage(t("maintenance.backup.done", { name: next.backups[0]?.name ?? "" }));
    });
  const removeBackup = (name: string) =>
    void run("delete-backup", () => deleteBackup(name), (next) => {
      showSnapshot(next);
      setMessage(t("maintenance.backup.deleted"));
    });
  const removeLegacy = (name: string) =>
    void run("delete-legacy", () => deleteLegacy(name), (next) => {
      showSnapshot(next);
      setMessage(t("maintenance.legacy.deleted"));
    });
  const runPreview = () =>
    void run(
      "preview",
      () =>
        cleanMaintenance({
          mode: "rebuildable",
          older_than_days: days(),
          archived_only: archivedOnly(),
        }),
      (result) => {
        setPreview(result);
        setCleanNote("");
      },
    );
  const runClean = async () => {
    const target = preview();
    if (!target || target.totals.sessions === 0) return;
    await run(
      "clean",
      () =>
        cleanMaintenance({
          mode: "rebuildable",
          session_ids: target.targets.map((row) => row.session_id),
          apply: true,
        }),
      (result) => {
        setPreview(undefined);
        setCleanNote(t("maintenance.clean.done", { n: result.deleted ?? 0 }));
        void refetch();
      },
    );
  };

  return (
    <div>
      <Show when={snapshot.error}>
        <p class="mt-3 text-sm text-destructive">{explain(snapshot.error)}</p>
      </Show>
      <Show when={snapshot.loading && !snapshot()}>
        <p class="mt-3 text-sm text-muted-foreground">{t("maintenance.loading")}</p>
      </Show>
      <Show when={snapshot()}>
        {(snap) => (
          <>
            <Group label={t("maintenance.storage")}>
              <div class="rounded-lg border border-border px-3 py-3">
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span class="text-xl font-medium tabular-nums">{fmtBytes(totalBytes())}</span>
                  <span class="text-2xs text-muted-foreground">
                    {t("maintenance.storage.files", {
                      db: fmtBytes(snap().db.bytes),
                      wal: fmtBytes(snap().db.wal_bytes),
                      content: fmtBytes(contentBytes()),
                    })}
                  </span>
                  <span
                    class="ml-auto max-w-[48%] truncate font-mono text-2xs text-muted-foreground"
                    title={snap().db.path ?? ""}
                  >
                    {snap().db.path ?? "—"}
                  </span>
                </div>
                <div class="mt-3 flex h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span
                    class="bg-chart-1"
                    style={{
                      width: `${pct(stats()!.rebuildable.bytes, contentBytes())}%`,
                      "min-width": stats()!.rebuildable.bytes > 0 ? "2px" : "0",
                    }}
                  />
                  <span
                    class="bg-chart-3"
                    style={{
                      width: `${pct(stats()!.local.bytes, contentBytes())}%`,
                      "min-width": stats()!.local.bytes > 0 ? "2px" : "0",
                    }}
                  />
                </div>
                <div class="mt-2 grid grid-cols-1 gap-1 text-2xs @min-[560px]/main:grid-cols-2">
                  <p class="text-muted-foreground">
                    <span class="text-foreground">{t("maintenance.rebuildable")}</span>{" "}
                    {num(stats()!.rebuildable.events)} · {fmtBytes(stats()!.rebuildable.bytes)}
                  </p>
                  <p class="text-muted-foreground">
                    <span class="text-foreground">{t("maintenance.local")}</span>{" "}
                    {num(stats()!.local.events)} · {fmtBytes(stats()!.local.bytes)}
                  </p>
                </div>
                <p class="mt-2 text-2xs leading-4 text-muted-foreground">
                  {t("maintenance.stats", {
                    sessions: num(stats()!.sessions),
                    events: num(stats()!.events),
                    fts: num(stats()!.fts),
                    oldest: stats()!.oldest ? date(Date.parse(stats()!.oldest!)) : "—",
                    newest: stats()!.newest ? date(Date.parse(stats()!.newest!)) : "—",
                  })}
                </p>
                <p class="mt-1 text-2xs leading-4 text-muted-foreground">
                  {t("maintenance.classHint")}
                </p>
              </div>
            </Group>

            <Group label={t("maintenance.actions")}>
              <div class="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy())}
                  onClick={() => void runCheck()}
                >
                  {t("maintenance.check")}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={Boolean(busy())}
                  onClick={() => void runOptimize()}
                >
                  {t("maintenance.optimize")}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={Boolean(busy())}
                  onClick={() => confirmAction("vacuum", () => void runVacuum())}
                >
                  {confirming() === "vacuum" ? t("maintenance.confirm") : t("maintenance.vacuum")}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={Boolean(busy())}
                  onClick={() => void runBackup()}
                >
                  {t("maintenance.backup")}
                </Button>
              </div>
              <Show when={check()}>
                {(rows) => (
                  <p
                    class={`mt-2 text-2xs leading-4 ${
                      rows().includes("ok") ? "text-muted-foreground" : "text-destructive"
                    }`}
                  >
                    {rows().includes("ok")
                      ? t("maintenance.check.ok")
                      : t("maintenance.check.failed", { detail: rows().slice(0, 3).join("; ") })}
                  </p>
                )}
              </Show>
              <Show when={message()}>
                <p class="mt-2 text-sm text-muted-foreground">{message()}</p>
              </Show>
              <Show when={error()}>
                <p class="mt-2 text-sm text-destructive">{error()}</p>
              </Show>

              <div class="mt-4">
                <p class="text-2xs text-muted-foreground">{t("maintenance.backups")}</p>
                <Show
                  when={snap().backups.length > 0}
                  fallback={
                    <p class="mt-1 text-2xs text-muted-foreground">
                      {t("maintenance.backups.none")}
                    </p>
                  }
                >
                  <ul class="mt-1 divide-y divide-border">
                    <For each={snap().backups}>
                      {(file) => (
                        <li class="flex items-center gap-2 py-1.5">
                          <span class="min-w-0 flex-1 truncate font-mono text-2xs" title={file.name}>
                            {file.name}
                          </span>
                          <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                            {fmtBytes(file.bytes)}
                          </span>
                          <span class="shrink-0 text-2xs text-muted-foreground">
                            {stamp(file.modified_at)}
                          </span>
                          <Button
                            type="button"
                            size="icon-2xs"
                            variant="icon"
                            class="shrink-0 text-muted-foreground"
                            aria-label={
                              confirming() === `backup:${file.name}`
                                ? t("maintenance.confirm")
                                : t("maintenance.backup.delete")
                            }
                            onClick={() =>
                              confirmAction(`backup:${file.name}`, () => removeBackup(file.name))
                            }
                          >
                            <Icon
                              name={confirming() === `backup:${file.name}` ? "check" : "x"}
                              class="size-3"
                            />
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>

              <Show when={snap().legacy.length > 0}>
                <div class="mt-4 rounded-lg border border-status-cancelled/40 px-3 py-2">
                  <p class="text-2xs leading-4 text-status-cancelled">
                    {t("maintenance.legacy.hint")}
                  </p>
                  <ul class="mt-1 divide-y divide-border">
                    <For each={snap().legacy}>
                      {(file) => (
                        <li class="flex items-center gap-2 py-1.5">
                          <span class="min-w-0 flex-1 truncate font-mono text-2xs" title={file.name}>
                            {file.name}
                          </span>
                          <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                            {fmtBytes(file.bytes)}
                          </span>
                          <Button
                            type="button"
                            size="icon-2xs"
                            variant="icon"
                            class="shrink-0 text-muted-foreground"
                            aria-label={
                              confirming() === `legacy:${file.name}`
                                ? t("maintenance.confirm")
                                : t("maintenance.legacy.delete")
                            }
                            onClick={() =>
                              confirmAction(`legacy:${file.name}`, () => removeLegacy(file.name))
                            }
                          >
                            <Icon
                              name={confirming() === `legacy:${file.name}` ? "check" : "x"}
                              class="size-3"
                            />
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </Group>

            <Group label={t("maintenance.clean")}>
              <p class="text-2xs leading-4 text-muted-foreground">{t("maintenance.clean.hint")}</p>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-2 text-2xs text-muted-foreground">
                  {t("maintenance.clean.older")}
                  <TextFieldInput
                    size="sm"
                    inputmode="numeric"
                    class="w-20"
                    value={daysText()}
                    onInput={(event) => {
                      const text = event.currentTarget.value;
                      setDaysText(text);
                      const next = Number(text);
                      if (Number.isFinite(next) && next > 0) setDays(Math.min(next, 3650));
                    }}
                  />
                  {t("maintenance.clean.days")}
                </label>
                <label class="flex items-center gap-2 text-2xs text-muted-foreground">
                  <Switch
                    checked={archivedOnly()}
                    aria-label={t("maintenance.clean.archivedOnly")}
                    onChange={() => setArchivedOnly((on) => !on)}
                  />
                  {t("maintenance.clean.archivedOnly")}
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy())}
                  onClick={() => void runPreview()}
                >
                  {t("maintenance.clean.preview")}
                </Button>
                <Show when={preview()}>
                  {(target) => (
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={Boolean(busy()) || target().totals.sessions === 0}
                      onClick={() => void runClean()}
                    >
                      {t("maintenance.clean.apply")}
                    </Button>
                  )}
                </Show>
              </div>
              <Show when={preview()}>
                {(target) => (
                  <div class="mt-3 rounded-lg border border-border px-3 py-2 text-2xs leading-5 text-muted-foreground">
                    <p>
                      {t("maintenance.clean.previewLine", {
                        n: target().totals.sessions,
                        rebuildable: num(target().totals.rebuildable),
                        local: num(target().totals.local),
                        size: fmtBytes(target().totals.rebuildable_bytes),
                      })}
                    </p>
                    <Show when={target().targets.length > 0}>
                      <ul class="mt-1 space-y-0.5">
                        <For each={target().targets.slice(0, 5)}>
                          {(row) => (
                            <li class="truncate">
                              {displayTitle(row.title) ?? t("common.untitled")}
                              <span class="ml-2 font-mono">{num(row.rebuildable)} / {num(row.local)}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={cleanNote()}>
                <p class="mt-2 text-sm text-muted-foreground">{cleanNote()}</p>
              </Show>
            </Group>


          </>
        )}
      </Show>
    </div>
  );
}
