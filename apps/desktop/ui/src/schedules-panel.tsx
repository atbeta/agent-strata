import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { Switch } from "@/components/ui/switch";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { Icon } from "@/icons";
import { Tip } from "@/tip";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  toggleSchedule,
  updateSchedule,
  type ScheduleRow,
} from "./api";
import { t } from "./i18n";
import {
  clockText,
  fromLocalInputValue,
  relativeTimeText,
  runResultText,
  showsTargetLine,
  targetText,
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
 */

/** What the reader is being asked to fill in. */
type Kind = "daily" | "weekly" | "every" | "at";
type Target = "here" | "named" | "new";

/** One session the reader may aim a schedule at. */
interface Candidate {
  session_id: string;
  title?: string;
}

export function SchedulesPanel(props: { sessionId: () => string }) {
  const [rows, setRows] = createSignal<ScheduleRow[]>([]);
  const [candidates, setCandidates] = createSignal<Candidate[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<string>();
  /** the schedule a second click would remove, so a stray one cannot delete */
  const [confirming, setConfirming] = createSignal<string>();

  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [kind, setKind] = createSignal<Kind>("daily");
  const [time, setTime] = createSignal("09:00");
  const [weekday, setWeekday] = createSignal(5);
  const [minutes, setMinutes] = createSignal("30");
  const [at, setAt] = createSignal("");
  const [target, setTarget] = createSignal<Target>("here");
  const [sessionId, setSessionId] = createSignal("");

  const reload = () => {
    void listSchedules(props.sessionId())
      .then((next) => {
        setRows(next.schedules);
        setCandidates(next.candidates);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  onMount(() => {
    reload();
    // The plugin announces a change when a schedule is made, paused or fires;
    // polling picks that up without a stream the panel would have to own.
    const timer = setInterval(reload, 5_000);
    onCleanup(() => clearInterval(timer));
  });

  /** The timing and the target, in the shape the plugin reads. */
  const input = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    switch (kind()) {
      case "daily":
        out.daily = time();
        break;
      case "weekly": {
        // The panel holds the weekday as the number it is, and the clock as
        // the two halves it was picked in. The plugin reads both.
        const [h, m] = time().split(":").map((n) => Number(n));
        out.weekly = { weekday: weekday(), hour: h || 0, minute: m || 0 };
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

  const reset = () => {
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

  /** What the reader still has to say, said in their own words. */
  const validate = (): string | undefined => {
    if (!name().trim()) return t("schedule.panel.err.nameRequired");
    if (!prompt().trim()) return t("schedule.panel.err.promptRequired");
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  /** The next moment this schedule fires, as the reader would say it. */
  const nextText = (row: ScheduleRow): string => {
    if (!row.enabled) return t("schedule.panel.paused");
    if (!row.next_at) return "";
    const at = Date.parse(row.next_at);
    if (!Number.isFinite(at)) return "";
    return relativeTimeText(at);
  };

  /** How the last run went, and when it was. */
  const lastText = (row: ScheduleRow): string => {
    const result = runResultText(row.last_result);
    if (!result) return t("schedule.panel.neverRan");
    if (!row.last_run_at) return result;
    const at = Date.parse(row.last_run_at);
    if (!Number.isFinite(at)) return result;
    return result + " · " + relativeTimeText(at, Date.now());
  };

  /** The session options the reader may aim a schedule at. */
  const targetOptions = () => {
    const options: Candidate[] = [{ session_id: props.sessionId() }];
    for (const c of candidates()) {
      if (c.session_id === props.sessionId()) continue;
      options.push(c);
    }
    return options;
  };

  const candidateLabel = (c: Candidate): string => {
    if (c.session_id === props.sessionId()) return t("schedule.panel.target.thisSession");
    return c.title || c.session_id;
  };

  return (
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <Show when={error()}>
        <p class="mb-2 rounded-md bg-destructive/10 px-2 py-1 text-2xs text-destructive">
          {error()}
        </p>
      </Show>

      <Show
        when={rows().length > 0}
        fallback={
          <EmptyState
            icon="clock"
            title={t("schedule.panel.empty")}
            description={t("schedule.panel.emptyHint")}
            layout="inline"
          />
        }
      >
        <div class="space-y-2">
          <For each={rows()}>
            {(row) => (
              <Card class="p-3">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <Icon name="clock" class="size-3.5 shrink-0 text-muted-foreground" />
                      <p class="truncate text-sm font-medium">{row.name}</p>
                    </div>
                    <p class="mt-0.5 truncate text-2xs text-muted-foreground">
                      {whenText(row.when)}
                    </p>
                  </div>

                  <div class="flex shrink-0 items-center gap-1">
                    <Tip label={t("schedule.panel.edit")}>
                      <Button
                        type="button"
                        variant="icon"
                        size="icon-xs"
                        aria-label={t("schedule.panel.edit")}
                        onClick={() => edit(row)}
                      >
                        <Icon name="pencil" class="size-3.5" />
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
                        size="icon-xs"
                        aria-label={t("schedule.panel.remove")}
                        class={confirming() === row.id ? "text-destructive" : undefined}
                        onClick={() => void remove(row)}
                      >
                        <Icon name="trash" class="size-3.5" />
                      </Button>
                    </Tip>
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

                <p class="mt-2 truncate text-2xs text-muted-foreground">{row.prompt}</p>

                <dl class="mt-2 space-y-1 border-t border-border pt-2 text-2xs">
                  <Show when={showsTargetLine(row, props.sessionId())}>
                    <div class="flex items-baseline gap-2">
                      <dt class="shrink-0 text-faint-foreground">
                        {t("schedule.panel.target.session")}
                      </dt>
                      <dd class="min-w-0 truncate text-muted-foreground">
                        {targetText(row, props.sessionId())}
                      </dd>
                    </div>
                  </Show>
                  <Show when={nextText(row)}>
                    <div class="flex items-baseline gap-2">
                      <dt class="shrink-0 text-faint-foreground">
                        {t("schedule.panel.nextRun")}
                      </dt>
                      <dd class="min-w-0 truncate text-muted-foreground">{nextText(row)}</dd>
                    </div>
                  </Show>
                  <div class="flex items-baseline gap-2">
                    <dt class="shrink-0 text-faint-foreground">
                      {t("schedule.panel.lastRun")}
                    </dt>
                    <dd class="min-w-0 truncate text-muted-foreground">{lastText(row)}</dd>
                  </div>
                </dl>
              </Card>
            )}
          </For>
        </div>
      </Show>

      <Card class="mt-3 p-3">
        <TextField>
          <TextFieldLabel>{t("schedule.panel.name")}</TextFieldLabel>
          <TextFieldInput
            size="sm"
            value={name()}
            placeholder={t("schedule.panel.namePlaceholder")}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </TextField>
        <TextField class="mt-2">
          <TextFieldLabel>{t("schedule.panel.prompt")}</TextFieldLabel>
          <TextFieldInput
            size="sm"
            value={prompt()}
            placeholder={t("schedule.panel.promptPlaceholder")}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
        </TextField>

        <div class="mt-3">
          <MiniTabs
            kind="radio"
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
        </div>

        <Show when={kind() === "daily" || kind() === "weekly"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.time")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="time"
              value={time()}
              onInput={(e) => setTime(e.currentTarget.value)}
            />
          </TextField>
        </Show>
        <Show when={kind() === "weekly"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.weekday")}</TextFieldLabel>
            <MiniTabs
              kind="radio"
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
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.minutes")}</TextFieldLabel>
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
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.onceAtLabel")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="datetime-local"
              value={at()}
              onInput={(e) => setAt(e.currentTarget.value)}
            />
          </TextField>
        </Show>

        <div class="mt-3">
          <MiniTabs
            kind="radio"
            label={t("schedule.panel.target.session")}
            value={target()}
            options={[
              { id: "here", label: t("schedule.panel.target.thisSession") },
              { id: "named", label: t("schedule.panel.target.named") },
              { id: "new", label: t("schedule.panel.target.newSession") },
            ]}
            onChange={(id) => setTarget(id as Target)}
          />
        </div>
        <Show when={target() === "named"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.sessionId")}</TextFieldLabel>
            <select
              class="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={sessionId()}
              onChange={(e) => setSessionId(e.currentTarget.value)}
            >
              <option value="">{t("schedule.panel.sessionId")}</option>
              <For each={targetOptions()}>
                {(c) => <option value={c.session_id}>{candidateLabel(c)}</option>}
              </For>
            </select>
          </TextField>
          <p class="mt-1 text-2xs text-muted-foreground">{t("schedule.panel.workspaceOnly")}</p>
        </Show>

        <div class="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy()} onClick={() => void submit()}>
            {editing() ? t("schedule.panel.save") : t("schedule.panel.create")}
          </Button>
          <Show when={editing()}>
            <Button type="button" size="sm" variant="quiet" onClick={reset}>
              {t("schedule.panel.cancel")}
            </Button>
          </Show>
        </div>
      </Card>
    </div>
  );
}
