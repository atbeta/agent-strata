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
import { Card, Group, Row } from "./settings-blocks";
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
  /** The row a result belongs to — a global banner would let the reader blame
   *  the wrong button for a failure. */
  const [feedback, setFeedback] = createSignal<{ key: string; ok: boolean; text: string }>();
  const [check, setCheck] = createSignal<string[]>();
  const [preview, setPreview] = createSignal<CleanResult>();
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

  const stats = () => snapshot()?.db.stats;
  const totalBytes = () => {
    const row = snapshot()?.db;
    return row ? row.bytes + row.wal_bytes + row.shm_bytes : 0;
  };
  const run = async <T,>(label: string, task: () => Promise<T>, done?: (value: T) => void) => {
    setBusy(label);
    try {
      const value = await task();
      done?.(value);
      return value;
    } catch (e) {
      setFeedback({ key: label, ok: false, text: explain(e) });
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
      setFeedback({ key: "optimize", ok: true, text: t("maintenance.optimize.done") });
    });
  const runVacuum = () =>
    void run("vacuum", () => optimizeMaintenance(true), (next) => {
      showSnapshot(next);
      setFeedback({ key: "vacuum", ok: true, text: t("maintenance.vacuum.done") });
    });
  const runBackup = () =>
    void run("backup", backupMaintenance, (next) => {
      showSnapshot(next);
      setFeedback({
        key: "backup",
        ok: true,
        text: t("maintenance.backup.done", { name: next.backups[0]?.name ?? "" }),
      });
    });
  const removeBackup = (name: string) =>
    void run("delete-backup", () => deleteBackup(name), (next) => {
      showSnapshot(next);
      setFeedback({ key: "delete-backup", ok: true, text: t("maintenance.backup.deleted") });
    });
  const removeLegacy = (name: string) =>
    void run("delete-legacy", () => deleteLegacy(name), (next) => {
      showSnapshot(next);
      setFeedback({ key: "delete-legacy", ok: true, text: t("maintenance.legacy.deleted") });
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
      },
    );
  /** A preview names the sessions the clean will touch; changing what it was
   *  asked for makes that list a different question's answer. */
  const resetPreview = () => {
    setPreview(undefined);
    if (confirming() === "clean") setConfirming("");
  };
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
        setFeedback({
          key: "clean",
          ok: true,
          text: t("maintenance.clean.done", { n: result.deleted ?? 0 }),
        });
        void refetch();
      },
    );
  };

  /** A result or failure sitting under the hint of the row that ran it. */
  const note = (key: string) => (
    <Show when={feedback() && feedback()!.key === key ? feedback() : undefined}>
      {(f) => (
        <p
          class={`mt-1.5 flex items-center gap-1.5 text-2xs ${
            f().ok ? "text-muted-foreground" : "text-destructive"
          }`}
        >
          <Icon name={f().ok ? "check" : "alert"} class="size-3 shrink-0" />
          {f().text}
        </p>
      )}
    </Show>
  );

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
              <Card>
                <div class="pt-3">
                  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span class="text-xl font-medium tabular-nums">{fmtBytes(totalBytes())}</span>
                    <span class="text-2xs text-muted-foreground">
                      {t("maintenance.storage.files", {
                        db: fmtBytes(snap().db.bytes),
                        wal: fmtBytes(snap().db.wal_bytes),
                      })}
                    </span>
                  </div>
                  <p
                    class="mt-1 max-w-full truncate font-mono text-2xs text-muted-foreground"
                    title={snap().db.path ?? ""}
                  >
                    {snap().db.path ?? "—"}
                  </p>
                </div>
                <div class="grid grid-cols-3 divide-x divide-border py-3">
                  <div class="px-3 first:pl-0">
                    <p class="text-2xs text-muted-foreground">{t("maintenance.sessions")}</p>
                    <p class="mt-0.5 text-sm tabular-nums text-foreground">
                      {num(stats()!.sessions)}
                    </p>
                  </div>
                  <div class="px-3 first:pl-0">
                    <p class="text-2xs text-muted-foreground">{t("maintenance.events")}</p>
                    <p class="mt-0.5 text-sm tabular-nums text-foreground">
                      {num(stats()!.events)}
                    </p>
                  </div>
                  <div class="px-3 first:pl-0">
                    <p class="text-2xs text-muted-foreground">{t("maintenance.span")}</p>
                    <p class="mt-0.5 text-sm tabular-nums text-foreground">
                      {stats()!.oldest && stats()!.newest
                        ? `${date(Date.parse(stats()!.oldest!))} – ${date(Date.parse(stats()!.newest!))}`
                        : "—"}
                    </p>
                  </div>
                </div>
                <div class="pb-1">
                  {(
                    [
                      { swatch: "bg-chart-1", name: t("maintenance.rebuildable"), hint: t("maintenance.rebuildable.hint"), row: stats()!.rebuildable },
                      { swatch: "bg-chart-3", name: t("maintenance.local"), hint: t("maintenance.local.hint"), row: stats()!.local },
                    ] as const
                  ).map((cls) => (
                    <div class="flex items-start gap-3 py-2">
                      <span class={`mt-1.5 size-2 shrink-0 rounded-full ${cls.swatch}`} />
                      <div class="min-w-0 flex-1">
                        <p class="text-sm text-foreground">{cls.name}</p>
                        <p class="mt-0.5 text-2xs text-muted-foreground">{cls.hint}</p>
                      </div>
                      <span class="shrink-0 pt-0.5 text-2xs tabular-nums text-muted-foreground">
                        {t("maintenance.class.figures", {
                          events: num(cls.row.events),
                          size: fmtBytes(cls.row.bytes),
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </Group>

            <Group label={t("maintenance.actions")}>
              <Card>
                <Row
                  label={t("maintenance.check")}
                  hint={t("maintenance.check.hint")}
                  controlClass="w-auto"
                  note={
                    <>
                      <Show when={check()}>
                        {(rows) => (
                          <p
                            class={`mt-1.5 flex items-center gap-1.5 text-2xs ${
                              rows().includes("ok")
                                ? "text-muted-foreground"
                                : "text-destructive"
                            }`}
                          >
                            <Icon
                              name={rows().includes("ok") ? "check" : "alert"}
                              class="size-3 shrink-0"
                            />
                            {rows().includes("ok")
                              ? t("maintenance.check.ok")
                              : t("maintenance.check.failed", {
                                  detail: rows().slice(0, 3).join("; "),
                                })}
                          </p>
                        )}
                      </Show>
                      {note("check")}
                    </>
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy())}
                    aria-busy={busy() === "check"}
                    onClick={() => void runCheck()}
                  >
                    <span class={busy() === "check" ? "opacity-50" : undefined}>
                      {t("maintenance.check.run")}
                    </span>
                  </Button>
                </Row>
                <Row
                  label={t("maintenance.optimize")}
                  hint={t("maintenance.optimize.hint")}
                  controlClass="w-auto"
                  note={note("optimize")}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy())}
                    aria-busy={busy() === "optimize"}
                    onClick={() => void runOptimize()}
                  >
                    <span class={busy() === "optimize" ? "opacity-50" : undefined}>
                      {t("maintenance.optimize")}
                    </span>
                  </Button>
                </Row>
                <Row
                  label={t("maintenance.vacuum")}
                  hint={t("maintenance.vacuum.hint")}
                  controlClass="w-auto"
                  note={note("vacuum")}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    class={
                      confirming() === "vacuum"
                        ? "text-destructive border-destructive/40"
                        : undefined
                    }
                    disabled={Boolean(busy())}
                    aria-busy={busy() === "vacuum"}
                    onClick={() => confirmAction("vacuum", () => void runVacuum())}
                  >
                    <span class={busy() === "vacuum" ? "opacity-50" : undefined}>
                      {confirming() === "vacuum"
                        ? t("maintenance.confirm")
                        : t("maintenance.vacuum.run")}
                    </span>
                  </Button>
                </Row>
                <Row
                  label={t("maintenance.backup")}
                  hint={t("maintenance.backup.hint")}
                  controlClass="w-auto"
                  note={note("backup")}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy())}
                    aria-busy={busy() === "backup"}
                    onClick={() => void runBackup()}
                  >
                    <span class={busy() === "backup" ? "opacity-50" : undefined}>
                      {t("maintenance.backup.run")}
                    </span>
                  </Button>
                </Row>
              </Card>
            </Group>

            <Group label={t("maintenance.backups")}>
              <Card class="px-0">
                <Show
                  when={snap().backups.length > 0}
                  fallback={
                    <p class="px-4 py-3 text-2xs text-muted-foreground">
                      {t("maintenance.backups.none")}
                    </p>
                  }
                >
                  <For each={snap().backups}>
                    {(file) => (
                      <div class="flex items-center gap-3 px-4 py-2.5">
                        <div class="min-w-0 flex-1">
                          <p class="truncate font-mono text-xs text-foreground" title={file.name}>
                            {file.name}
                          </p>
                          <p class="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                            {fmtBytes(file.bytes)} · {stamp(file.modified_at)}
                          </p>
                        </div>
                        <Show
                          when={confirming() === `backup:${file.name}`}
                          fallback={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="icon"
                              class="shrink-0"
                              aria-label={t("maintenance.backup.delete")}
                              onClick={() =>
                                confirmAction(`backup:${file.name}`, () =>
                                  removeBackup(file.name),
                                )
                              }
                            >
                              <Icon name="x" class="size-3.5" />
                            </Button>
                          }
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="quiet"
                            class="shrink-0 text-destructive"
                            onClick={() =>
                              confirmAction(`backup:${file.name}`, () => removeBackup(file.name))
                            }
                          >
                            {t("maintenance.confirm.delete")}
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </Card>
              {note("delete-backup")}

              <Show when={snap().legacy.length > 0}>
                <div class="mt-3">
                  <p class="flex items-center gap-1.5 text-2xs text-status-cancelled">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {t("maintenance.legacy.hint")}
                  </p>
                  <Card class="mt-1.5 px-0">
                    <For each={snap().legacy}>
                      {(file) => (
                        <div class="flex items-center gap-3 px-4 py-2.5">
                          <div class="min-w-0 flex-1">
                            <p class="truncate font-mono text-xs text-foreground" title={file.name}>
                              {file.name}
                            </p>
                            <p class="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                              {fmtBytes(file.bytes)} · {stamp(file.modified_at)}
                            </p>
                          </div>
                          <Show
                            when={confirming() === `legacy:${file.name}`}
                            fallback={
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="icon"
                                class="shrink-0"
                                aria-label={t("maintenance.legacy.delete")}
                                onClick={() =>
                                  confirmAction(`legacy:${file.name}`, () =>
                                    removeLegacy(file.name),
                                  )
                                }
                              >
                                <Icon name="x" class="size-3.5" />
                              </Button>
                            }
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="quiet"
                              class="shrink-0 text-destructive"
                              onClick={() =>
                                confirmAction(`legacy:${file.name}`, () => removeLegacy(file.name))
                              }
                            >
                              {t("maintenance.confirm.delete")}
                            </Button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Card>
                  {note("delete-legacy")}
                </div>
              </Show>
            </Group>

            <Group label={t("maintenance.clean")}>
              <Card>
                <div>
                  <p class="pt-3 text-2xs leading-5 text-muted-foreground">
                    {t("maintenance.clean.hint")}
                  </p>
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <label class="flex items-center gap-2 text-2xs text-muted-foreground">
                    {t("maintenance.clean.older")}
                    <TextFieldInput
                      size="sm"
                      inputmode="numeric"
                      class="w-16 text-center"
                      value={daysText()}
                      onInput={(event) => {
                        const text = event.currentTarget.value;
                        setDaysText(text);
                        const next = Math.floor(Number(text));
                        if (Number.isFinite(next) && next > 0 && Math.min(next, 3650) !== days()) {
                          setDays(Math.min(next, 3650));
                          resetPreview();
                        }
                      }}
                      onBlur={() => setDaysText(String(days()))}
                    />
                    {t("maintenance.clean.days")}
                  </label>
                  <div class="flex items-center gap-2 text-2xs text-muted-foreground">
                    <Switch
                      checked={archivedOnly()}
                      aria-label={t("maintenance.clean.archivedOnly")}
                      onChange={(next) => {
                        setArchivedOnly(next);
                        resetPreview();
                      }}
                    />
                    {t("maintenance.clean.archivedOnly")}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    class="ml-auto"
                    disabled={Boolean(busy())}
                    aria-busy={busy() === "preview"}
                    onClick={() => void runPreview()}
                  >
                    <span class={busy() === "preview" ? "opacity-50" : undefined}>
                      {t("maintenance.clean.preview")}
                    </span>
                  </Button>
                  </div>
                </div>
                <Show when={preview() || (feedback()?.key === "preview") || (feedback()?.key === "clean")}>
                  <div class="py-3">
                    <Show when={preview()}>
                      {(target) => (
                        <Show
                          when={target().totals.sessions > 0}
                          fallback={
                            <p class="text-2xs text-muted-foreground">
                              {t("maintenance.clean.nothing")}
                            </p>
                          }
                        >
                          <p class="text-xs text-foreground">
                            {t("maintenance.clean.previewLine", {
                              n: target().totals.sessions,
                              rebuildable: num(target().totals.rebuildable),
                              local: num(target().totals.local),
                              size: fmtBytes(target().totals.rebuildable_bytes),
                            })}
                          </p>
                          <table class="mt-2 w-full text-2xs">
                            <thead>
                              <tr class="text-muted-foreground">
                                <th class="py-1 pr-2 text-left font-normal">
                                  {t("maintenance.sessions")}
                                </th>
                                <th class="px-2 py-1 text-right font-normal">
                                  {t("maintenance.rebuildable")}
                                </th>
                                <th class="py-1 pl-2 text-right font-normal">
                                  {t("maintenance.local")}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={target().targets.slice(0, 5)}>
                                {(row) => (
                                  <tr class="border-t border-border/50">
                                    <td class="max-w-0 py-1 pr-2">
                                      <span
                                        class="block truncate text-muted-foreground"
                                        title={displayTitle(row.title) ?? t("common.untitled")}
                                      >
                                        {displayTitle(row.title) ?? t("common.untitled")}
                                      </span>
                                    </td>
                                    <td class="px-2 py-1 text-right tabular-nums text-muted-foreground">
                                      {num(row.rebuildable)}
                                    </td>
                                    <td class="py-1 pl-2 text-right tabular-nums text-muted-foreground">
                                      {num(row.local)}
                                    </td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                          <Show when={target().targets.length > 5}>
                            <p class="mt-1 text-2xs text-muted-foreground">
                              {t("maintenance.clean.andMore", {
                                n: target().targets.length - 5,
                              })}
                            </p>
                          </Show>
                          <div class="mt-3 flex items-center justify-end gap-3">
                            <Button
                              size="sm"
                              variant="outline"
                              class="text-destructive border-destructive/40 hover:bg-destructive/10"
                              disabled={Boolean(busy())}
                              aria-busy={busy() === "clean"}
                              onClick={() => confirmAction("clean", () => void runClean())}
                            >
                              <span class={busy() === "clean" ? "opacity-50" : undefined}>
                                {confirming() === "clean"
                                  ? t("maintenance.confirm")
                                  : t("maintenance.clean.applyN", {
                                      n: target().totals.sessions,
                                    })}
                              </span>
                            </Button>
                          </div>
                        </Show>
                      )}
                    </Show>
                    <Show when={feedback() && (feedback()!.key === "preview" || feedback()!.key === "clean") ? feedback() : undefined}>
                      {(f) => (
                        <p
                          class={`flex items-center gap-1.5 text-2xs ${
                            preview() ? "mt-3" : ""
                          } ${f().ok ? "text-muted-foreground" : "text-destructive"}`}
                        >
                          <Icon name={f().ok ? "check" : "alert"} class="size-3 shrink-0" />
                          {f().text}
                        </p>
                      )}
                    </Show>
                  </div>
                </Show>
              </Card>
            </Group>
          </>
        )}
      </Show>
    </div>
  );
}
