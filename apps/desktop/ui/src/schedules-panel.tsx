import { createSignal, For, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldVariants } from "@/components/ui/field";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { Switch } from "@/components/ui/switch";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { Tip } from "@/tip";
import {
  createSchedule,
  deleteSchedule,
  toggleSchedule,
  updateSchedule,
  type ScheduleCandidate,
  type ScheduleRow,
} from "./api";
import { t } from "./i18n";
import { ScheduleDateTimeField } from "./schedule-date-time";
import { ScheduleSessionPicker } from "./schedule-session-picker";
import type { SchedulesController } from "./use-schedules";
import {
  clockText,
  fromLocalInputValue,
  parseClock,
  scheduleFacts,
  toLocalInputValue,
  whenText,
  weekdayName,
} from "./schedule-format";

/**
 * The schedules panel: the reader's own timed prompts.
 *
 * The plugin holds the schedules and every rule about them; this draws them
 * and takes the reader's answers back. A plugin cannot ship a component into
 * this window, so the shape lives here and the data is the plugin's.
 *
 * A schedule belongs to the session that made it and may only reach that
 * session's workspace - the same boundary the tools keep. The panel is that
 * session's panel, so the reader is scheduling inside their own workspace.
 *
 * Everything a reader sees here is in their own language. The wire values
 * that come back from the plugin - a weekday as a number, a run result as
 * "skipped-busy" - are turned into words by ./schedule-format, and the
 * plugin sends a target session's title so "where does this go" is
 * answerable without reading an id.
 *
 * The list is the panel. The form replaces it while the reader makes or edits
 * a schedule, so neither the form nor the cards have to compete for a narrow rail.
 */

/** What the reader is being asked to fill in. */
type Kind = "daily" | "weekly" | "every" | "at";
type Target = "here" | "named" | "new";

export function SchedulesPanel(props: {
  sessionId: () => string;
  controller: SchedulesController;
}) {
  const rows = props.controller.rows;
  const candidates = props.controller.candidates;
  const loadState = props.controller.loadState;
  const [formError, setError] = createSignal<string>();
  const error = () => formError() ?? props.controller.error();
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<string>();
  /** the form is closed until the reader asks to make or change one */
  const [composing, setComposing] = createSignal(false);
  /** the schedule a second click would remove, so a stray one cannot delete */
  const [confirming, setConfirming] = createSignal<string>();
  let formEl: HTMLDivElement | undefined;

  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("daily");
  const [time, setTime] = createSignal("09:00");
  const [weekday, setWeekday] = createSignal(5);
  const [minutes, setMinutes] = createSignal("30");
  const [at, setAt] = createSignal("");
  const [target, setTarget] = createSignal<Target>("here");
  const [sessionId, setSessionId] = createSignal("");
  const reload = props.controller.reload;

  /** The timing and the target, in the shape the plugin reads. */
  const input = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const clock = parseClock(time());
    switch (kind()) {
      case "daily":
        out.daily = clock ? clockText(clock.hour, clock.minute) : time();
        break;
      case "weekly": {
        // The panel holds the weekday as the number it is, and the clock as
        // the two halves it was typed in. The plugin reads both.
        out.weekly = { weekday: weekday(), hour: clock?.hour ?? 0, minute: clock?.minute ?? 0 };
        break;
      }
      case "every":
        out.every_minutes = Number(minutes());
        break;
      case "at":
        // The picker holds a wall-clock moment in the reader's own timezone;
        // the plugin wants an instant, so it is converted here rather than
        // being read as UTC somewhere else.
        out.at = fromLocalInputValue(at()) ?? undefined;
        break;
    }
    if (target() === "named") out.session_id = sessionId();
    if (target() === "new") out.new_session = true;
    return out;
  };

  const clearFields = () => {
    setName("");
    setPrompt("");
    setKind("daily");
    setTime("09:00");
    setWeekday(5);
    setMinutes("30");
    setAt("");
    setTarget("here");
    setSessionId("");
    setEditing("");
    setError(undefined);
  };

  const reset = () => {
    clearFields();
    setComposing(false);
  };

  /** The form lives above the list; opening it should land the reader on it. */
  const reveal = () => {
    setComposing(true);
    queueMicrotask(() => {
      if (typeof formEl?.scrollIntoView === "function") {
        formEl.scrollIntoView({ block: "nearest" });
      }
    });
  };

  /**
   * The session a reader can recognise the clashing schedule by.
   *
   * A schedule id answers nothing. The title the plugin already resolved
   * does; this session's own label does when the prompt lands here. A raw
   * session id is left out — it is no more readable than `sch_…`.
   */
  const clashSession = (row: ScheduleRow): string | undefined => {
    const title = row.target_title?.trim();
    if (title) return title;
    if (row.target.kind !== "session") return undefined;
    const id = String(row.target.session_id ?? "");
    if (!id) return undefined;
    if (id === props.sessionId()) return t("schedule.panel.target.thisSession");
    return candidates().find((c) => c.session_id === id)?.title?.trim() || undefined;
  };

  /** A name already on another schedule, in the reader's own words. */
  const duplicateName = (trimmed: string): string | undefined => {
    const clash = rows().find((row) => row.name === trimmed && row.id !== editing());
    if (!clash) return undefined;
    const session = clashSession(clash);
    return session
      ? t("schedule.panel.err.nameTakenBy", { name: trimmed, session })
      : t("schedule.panel.err.nameTaken", { name: trimmed });
  };

  /**
   * The service still says the name is taken, in English and without a
   * session, when the list the panel checked was already stale.
   */
  const explainSubmit = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    const taken = /^the name (.*) is already taken$/.exec(message);
    if (!taken) return message;
    const named = taken[1] ?? "";
    return duplicateName(named) ?? t("schedule.panel.err.nameTaken", { name: named });
  };

  /** What the reader still has to say, said in their own words. */
  const validate = (): string | undefined => {
    const trimmed = name().trim();
    if (!trimmed) return t("schedule.panel.err.nameRequired");
    const taken = duplicateName(trimmed);
    if (taken) return taken;
    if (!prompt().trim()) return t("schedule.panel.err.promptRequired");
    if ((kind() === "daily" || kind() === "weekly") && !parseClock(time())) {
      return t("schedule.panel.err.timeInvalid");
    }
    if (kind() === "at") {
      const ms = fromLocalInputValue(at());
      if (ms === null) return t("schedule.panel.err.atRequired");
      if (ms <= Date.now()) return t("schedule.panel.err.atPast");
    }
    if (kind() === "every" && Number(minutes()) < 5) {
      return t("schedule.panel.err.minutesInvalid");
    }
    if (target() === "named" && !sessionId().trim()) {
      return t("schedule.panel.err.sessionRequired");
    }
    return undefined;
  };

  const submit = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const current = editing();
      const payload = { ...input(), name: name().trim(), prompt: prompt().trim() };
      if (current) await updateSchedule(props.sessionId(), current, payload);
      else await createSchedule(props.sessionId(), payload);
      reset();
      reload();
    } catch (e) {
      setError(explainSubmit(e));
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    clearFields();
    reveal();
  };

  const edit = (row: ScheduleRow) => {
    setEditing(row.id);
    setName(row.name);
    setPrompt(row.prompt);
    const when = row.when;
    if (when.kind === "daily") {
      setKind("daily");
      setTime(clockText(when.hour, when.minute) || "09:00");
    } else if (when.kind === "weekly") {
      setKind("weekly");
      setWeekday(Number(when.weekday ?? 5));
      setTime(clockText(when.hour, when.minute) || "09:00");
    } else if (when.kind === "every") {
      setKind("every");
      setMinutes(String(Math.round(Number(when.everyMs ?? 1_800_000) / 60_000)));
    } else {
      setKind("at");
      setAt(toLocalInputValue(Number(when.at ?? Date.now())));
    }
    if (row.target.kind === "new_session") setTarget("new");
    else if (row.target.kind === "session" && row.target.session_id !== props.sessionId()) {
      setTarget("named");
      setSessionId(String(row.target.session_id ?? ""));
    } else {
      setTarget("here");
    }
    setError(undefined);
    reveal();
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Two clicks to remove, so a stray one cannot. */
  const remove = async (row: ScheduleRow) => {
    if (confirming() !== row.id) {
      setConfirming(row.id);
      setTimeout(() => setConfirming((c) => (c === row.id ? "" : c)), 3_000);
      return;
    }
    setConfirming("");
    await act(() => deleteSchedule(row.id));
  };

  /** The session options the reader may aim a schedule at. */
  const targetOptions = (): ScheduleCandidate[] => {
    const options: ScheduleCandidate[] = [
      { session_id: props.sessionId(), title: t("schedule.panel.target.thisSession") },
    ];
    for (const c of candidates()) {
      if (c.session_id === props.sessionId()) continue;
      options.push(c);
    }
    const selected = sessionId();
    if (selected && !options.some((option) => option.session_id === selected)) {
      const title = rows().find((row) => row.id === editing())?.target_title;
      options.splice(1, 0, { session_id: selected, title });
    }
    return options;
  };

  return (
    <div class="min-h-0 flex-1 overflow-auto">
      <Show when={error()}>
        <div class="px-3 pt-3" role="alert">
          <div class="flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-2xs leading-4 text-destructive">
            <Icon name="alert" class="mt-0.5 size-3.5 shrink-0" />
            <p class="min-w-0 break-words">{error()}</p>
          </div>
        </div>
      </Show>

      <Show
        when={composing()}
        fallback={
          <div class="p-3">
            <div class="mb-3 flex h-8 items-center justify-between gap-3 px-1">
              <div class="flex min-w-0 items-baseline gap-2">
                <h2 class="truncate text-sm font-semibold">{t("plugin.schedule.name")}</h2>
                <Show when={loadState() === "ready"}>
                  <span class="text-2xs text-muted-foreground">{rows().length}</span>
                </Show>
              </div>
              <Button
                type="button"
                size="xs"
                disabled={loadState() === "loading" || busy()}
                onClick={startCreate}
              >
                <Icon name="plus" class="size-3.5" />
                {t("schedule.panel.new")}
              </Button>
            </div>

            <Show
              when={loadState() !== "loading"}
              fallback={
                <div class="space-y-2" role="status" aria-live="polite">
                  <span class="sr-only">{t("schedule.panel.loading")}</span>
                  <For each={[0, 1]}>
                    {() => (
                      <div class="h-32 rounded-lg border border-border bg-card p-3">
                        <div class="h-3.5 w-2/5 rounded bg-secondary/70" />
                        <div class="mt-2 h-3 w-1/3 rounded bg-secondary/50" />
                        <div class="mt-4 h-3 w-11/12 rounded bg-secondary/40" />
                        <div class="mt-2 h-3 w-3/5 rounded bg-secondary/40" />
                      </div>
                    )}
                  </For>
                </div>
              }
            >
              <Show
                when={rows().length > 0}
                fallback={
                  <Show when={loadState() === "ready"}>
                    <EmptyState
                      icon="clock"
                      class="py-12"
                      title={t("schedule.panel.empty")}
                      description={t("schedule.panel.emptyHint")}
                    />
                  </Show>
                }
              >
                <div class="space-y-2">
                  <For each={rows()}>
                    {(row) => {
                      const facts = () => scheduleFacts(row, props.sessionId());
                      return (
                        <Card class={cn("px-3 py-2.5", editing() === row.id && "ring-1 ring-ring")}>
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <p
                                class={cn(
                                  "truncate text-sm font-medium",
                                  !row.enabled && "text-muted-foreground",
                                )}
                              >
                                {row.name}
                              </p>
                              <div class="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                                <Icon name="clock" class="size-3 shrink-0" />
                                <p class="truncate">{whenText(row.when)}</p>
                              </div>
                            </div>
                            <div class="flex shrink-0 items-center gap-0.5">
                              <Tip label={t("schedule.panel.edit")}>
                                <Button
                                  type="button"
                                  variant="icon"
                                  size="icon-2xs"
                                  aria-label={t("schedule.panel.edit")}
                                  onClick={() => edit(row)}
                                >
                                  <Icon name="pencil" class="size-3" />
                                </Button>
                              </Tip>
                              <Tip
                                label={
                                  confirming() === row.id
                                    ? t("schedule.panel.confirmRemove")
                                    : t("schedule.panel.remove")
                                }
                              >
                                <Button
                                  type="button"
                                  variant="icon"
                                  size="icon-2xs"
                                  aria-label={t("schedule.panel.remove")}
                                  class={confirming() === row.id ? "text-destructive" : undefined}
                                  onClick={() => void remove(row)}
                                >
                                  <Icon name="trash" class="size-3" />
                                </Button>
                              </Tip>
                              <span class="mx-0.5 h-3.5 w-px bg-border" aria-hidden="true" />
                              <Switch
                                checked={row.enabled}
                                disabled={busy()}
                                aria-label={
                                  row.enabled ? t("schedule.panel.pause") : t("schedule.panel.resume")
                                }
                                onChange={() => act(() => toggleSchedule(row.id))}
                              />
                            </div>
                          </div>

                          <p
                            class={cn(
                              "mt-2 line-clamp-2 break-words text-xs leading-5",
                              row.enabled ? "text-foreground/90" : "text-muted-foreground",
                            )}
                          >
                            {row.prompt}
                          </p>
                          <Show when={facts().target}>
                            <div class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                              <Icon name="message" class="size-3 shrink-0" />
                              <p class="truncate">{facts().target}</p>
                            </div>
                          </Show>
                          <p class="mt-2 border-t border-border/60 pt-1.5 text-2xs leading-3.5 text-faint-foreground">
                            <Show when={facts().next}>
                              {(text) => (
                                <>
                                  {text()}
                                  <span> · </span>
                                </>
                              )}
                            </Show>
                            <span class={toneClass(facts().tone)}>{facts().last}</span>
                          </p>
                          <Show when={confirming() === row.id}>
                            <p class="mt-2 text-2xs text-destructive">
                              {t("schedule.panel.confirmRemove")}
                            </p>
                          </Show>
                        </Card>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        }
      >
        <div ref={(el) => (formEl = el)} class="p-3">
          <Card class="p-4">
            <div class="mb-4 flex items-center justify-between gap-3">
              <p class="min-w-0 truncate text-sm font-semibold">
                {editing()
                  ? t("schedule.panel.editing", {
                      name: rows().find((r) => r.id === editing())?.name || name(),
                    })
                  : t("schedule.panel.creating")}
              </p>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                aria-label={t("schedule.panel.cancel")}
                onClick={reset}
              >
                <Icon name="x" class="size-3.5" />
              </Button>
            </div>

            <section>
              <TextField class="gap-1.5">
                <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                  {t("schedule.panel.name")}
                </TextFieldLabel>
                <TextFieldInput
                  size="sm"
                  value={name()}
                  placeholder={t("schedule.panel.namePlaceholder")}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </TextField>
              <TextField id="schedule-prompt" class="mt-3 gap-1.5">
                <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                  {t("schedule.panel.prompt")}
                </TextFieldLabel>
                <textarea
                  id="schedule-prompt"
                  rows={3}
                  class={cn(
                    fieldVariants({ size: "sm" }),
                    "!h-auto min-h-24 resize-y py-2 leading-5",
                  )}
                  value={prompt()}
                  placeholder={t("schedule.panel.promptPlaceholder")}
                  onInput={(e) => setPrompt(e.currentTarget.value)}
                />
              </TextField>
            </section>

            <section class="mt-5 border-t border-border pt-4">
              <p class="mb-3 text-2xs font-medium text-muted-foreground">
                {t("schedule.panel.sectionTiming")}
              </p>
              <MiniTabs
                kind="radio"
                class="grid grid-cols-4 rounded-lg border border-border p-1"
                label={t("schedule.panel.kind")}
                value={kind()}
                options={[
                  { id: "daily", label: t("schedule.panel.daily") },
                  { id: "weekly", label: t("schedule.panel.weekly") },
                  { id: "every", label: t("schedule.panel.every") },
                  { id: "at", label: t("schedule.panel.once") },
                ]}
                onChange={(id) => setKind(id as Kind)}
              />

              <Show when={kind() === "daily" || kind() === "weekly"}>
                <TextField class="mt-3 gap-1.5">
                  <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                    {t("schedule.panel.time")}
                  </TextFieldLabel>
                  <TextFieldInput
                    size="sm"
                    value={time()}
                    inputMode="numeric"
                    spellcheck={false}
                    placeholder="09:30"
                    onInput={(e) => setTime(e.currentTarget.value)}
                  />
                </TextField>
              </Show>
              <Show when={kind() === "weekly"}>
                <TextField class="mt-3 gap-1.5">
                  <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                    {t("schedule.panel.weekday")}
                  </TextFieldLabel>
                  <MiniTabs
                    kind="radio"
                    class="flex-wrap gap-1"
                    label={t("schedule.panel.weekday")}
                    value={String(weekday())}
                    options={[0, 1, 2, 3, 4, 5, 6].map((d) => ({
                      id: String(d),
                      label: weekdayName(d),
                    }))}
                    onChange={(id) => setWeekday(Number(id))}
                  />
                </TextField>
              </Show>
              <Show when={kind() === "every"}>
                <TextField class="mt-3 gap-1.5">
                  <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                    {t("schedule.panel.minutes")}
                  </TextFieldLabel>
                  <TextFieldInput
                    size="sm"
                    type="number"
                    min={5}
                    step={5}
                    value={minutes()}
                    onInput={(e) => setMinutes(e.currentTarget.value)}
                  />
                </TextField>
              </Show>
              <Show when={kind() === "at"}>
                <TextField class="mt-3 gap-1.5">
                  <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                    {t("schedule.panel.onceAtLabel")}
                  </TextFieldLabel>
                  <ScheduleDateTimeField value={at()} onChange={setAt} />
                </TextField>
              </Show>
            </section>

            <section class="mt-5 border-t border-border pt-4">
              <p class="mb-3 text-2xs font-medium text-muted-foreground">
                {t("schedule.panel.sectionTarget")}
              </p>
              <MiniTabs
                kind="radio"
                class="grid grid-cols-3 rounded-lg border border-border p-1"
                label={t("schedule.panel.target.session")}
                value={target()}
                options={[
                  { id: "here", label: t("schedule.panel.target.thisSession") },
                  { id: "named", label: t("schedule.panel.target.named") },
                  { id: "new", label: t("schedule.panel.target.newSessionShort") },
                ]}
                onChange={(id) => setTarget(id as Target)}
              />
              <Show when={target() === "named"}>
                <TextField class="mt-3 gap-1.5">
                  <TextFieldLabel class="text-xs font-normal text-muted-foreground">
                    {t("schedule.panel.sessionId")}
                  </TextFieldLabel>
                  <ScheduleSessionPicker
                    value={sessionId()}
                    options={targetOptions()}
                    onChange={setSessionId}
                  />
                </TextField>
                <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">
                  {t("schedule.panel.workspaceOnly")}
                </p>
              </Show>
            </section>

            <div class="mt-5 flex items-center gap-2 border-t border-border pt-4">
              <Button type="button" size="sm" disabled={busy()} onClick={() => void submit()}>
                {editing() ? t("schedule.panel.save") : t("schedule.panel.create")}
              </Button>
              <Button type="button" size="sm" variant="quiet" onClick={reset}>
                {t("schedule.panel.cancel")}
              </Button>
            </div>
          </Card>
        </div>
      </Show>
    </div>
  );
}

/** A failed or missed run is the line the eye should find; a success is not. */
function toneClass(tone: "neutral" | "warn" | "bad"): string | undefined {
  if (tone === "bad") return "text-status-error";
  if (tone === "warn") return "text-status-cancelled";
  return undefined;
}
