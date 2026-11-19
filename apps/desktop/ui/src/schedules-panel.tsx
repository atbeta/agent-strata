import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  toggleSchedule,
  updateSchedule,
  type ScheduleRow,
} from "./api";
import { t } from "./i18n";

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
 */
export function SchedulesPanel(props: { sessionId: () => string }) {
  const [rows, setRows] = createSignal<ScheduleRow[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<string>();

  const [name, setName] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [kind, setKind] = createSignal<"daily" | "weekly" | "every" | "at">("daily");
  const [time, setTime] = createSignal("09:00");
  const [weekday, setWeekday] = createSignal("fri");
  const [minutes, setMinutes] = createSignal("30");
  const [at, setAt] = createSignal("");
  const [target, setTarget] = createSignal<"here" | "named" | "new">("here");
  const [sessionId, setSessionId] = createSignal("");

  /** "09:30" from the hour and minute the plugin stored. */
  const hhmm = (hour: unknown, minute: unknown): string =>
    `${String(hour ?? 0).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;

  const reload = () => {
    void listSchedules(props.sessionId())
      .then((next) => {
        setRows(next);
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
      case "weekly":
        out.weekly = `${weekday()} ${time()}`;
        break;
      case "every":
        out.every_minutes = Number(minutes());
        break;
      case "at":
        out.at = at();
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
    setWeekday("fri");
    setMinutes("30");
    setAt("");
    setTarget("here");
    setSessionId("");
    setEditing("");
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const current = editing();
      const payload = { ...input(), name: name(), prompt: prompt() };
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
      setTime(hhmm(when.hour, when.minute));
    } else if (when.kind === "weekly") {
      setKind("weekly");
      setWeekday(String(when.weekday ?? "fri"));
      setTime(hhmm(when.hour, when.minute));
    } else if (when.kind === "every") {
      setKind("every");
      setMinutes(String(Math.round(Number(when.everyMs ?? 1_800_000) / 60_000)));
    } else {
      setKind("at");
      setAt(String(when.at ?? ""));
    }
    if (row.target.kind === "new_session") setTarget("new");
    else if (row.target.kind === "session" && row.target.session_id !== props.sessionId()) {
      setTarget("named");
      setSessionId(String(row.target.session_id ?? ""));
    } else {
      setTarget("here");
    }
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

  /** One line saying when it runs and where it lands. */
  const whenText = (row: ScheduleRow): string => {
    const when = row.when;
    switch (when.kind) {
      case "daily":
        return t("schedule.panel.dailyAt", { time: hhmm(when.hour, when.minute) });
      case "weekly":
        return t("schedule.panel.weeklyAt", {
          weekday: String(when.weekday ?? ""),
          time: hhmm(when.hour, when.minute),
        });
      case "every":
        return t("schedule.panel.everyMinutes", {
          minutes: String(Math.round(Number(when.everyMs ?? 0) / 60_000)),
        });
      default:
        return t("schedule.panel.onceAt", { at: String(when.at ?? "") });
    }
  };

  const targetText = (row: ScheduleRow): string =>
    row.target.kind === "new_session" ? t("schedule.panel.newSession") : t("schedule.panel.thisSession");

  return (
    <div class="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      <Show when={error()}>
        <p class="text-2xs text-destructive">{error()}</p>
      </Show>

      <For each={rows()}>
        {(row) => (
          <div class="rounded-md border border-border p-2">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{row.name}</p>
                <p class="text-2xs text-muted-foreground">
                  {whenText(row)} · {targetText(row)}
                </p>
                <p class="truncate text-2xs text-muted-foreground">{row.prompt}</p>
                <Show when={row.last_result}>
                  <p class="text-2xs text-muted-foreground">
                    {t("schedule.panel.last", { result: String(row.last_result) })}
                    {row.last_note ? ` · ${row.last_note}` : ""}
                  </p>
                </Show>
              </div>
              <Switch
                checked={row.enabled}
                disabled={busy()}
                aria-label={row.enabled ? t("schedule.panel.pause") : t("schedule.panel.resume")}
                onChange={() => act(() => toggleSchedule(row.id))}
              />
            </div>
            <div class="mt-2 flex gap-1">
              <Button type="button" size="sm" variant="quiet" onClick={() => edit(row)}>
                {t("schedule.panel.edit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="quiet"
                onClick={() => act(() => deleteSchedule(row.id))}
              >
                {t("schedule.panel.remove")}
              </Button>
            </div>
          </div>
        )}
      </For>

      <Show when={rows().length === 0}>
        <p class="text-xs text-muted-foreground">{t("schedule.panel.empty")}</p>
      </Show>

      <div class="rounded-md border border-border p-2">
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

        <div class="mt-2 flex flex-wrap gap-1">
          <For
            each={[
              { id: "daily", label: t("schedule.panel.daily") },
              { id: "weekly", label: t("schedule.panel.weekly") },
              { id: "every", label: t("schedule.panel.every") },
              { id: "at", label: t("schedule.panel.once") },
            ]}
          >
            {(option) => (
              <Button
                type="button"
                size="sm"
                variant={kind() === option.id ? "outline" : "quiet"}
                onClick={() => setKind(option.id as "daily" | "weekly" | "every" | "at")}
              >
                {option.label}
              </Button>
            )}
          </For>
        </div>

        <Show when={kind() === "daily" || kind() === "weekly"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.time")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="text"
              value={time()}
              placeholder="09:00"
              onInput={(e) => setTime(e.currentTarget.value)}
            />
          </TextField>
        </Show>
        <Show when={kind() === "weekly"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.weekday")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="text"
              value={weekday()}
              placeholder="fri"
              onInput={(e) => setWeekday(e.currentTarget.value)}
            />
          </TextField>
        </Show>
        <Show when={kind() === "every"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.minutes")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="text"
              value={minutes()}
              placeholder="30"
              onInput={(e) => setMinutes(e.currentTarget.value)}
            />
          </TextField>
        </Show>
        <Show when={kind() === "at"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.onceAtLabel")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              type="text"
              value={at()}
              placeholder="2026-12-01T09:00"
              onInput={(e) => setAt(e.currentTarget.value)}
            />
          </TextField>
        </Show>

        <div class="mt-2 flex flex-wrap gap-1">
          <For
            each={[
              { id: "here", label: t("schedule.panel.thisSession") },
              { id: "named", label: t("schedule.panel.namedSession") },
              { id: "new", label: t("schedule.panel.newSession") },
            ]}
          >
            {(option) => (
              <Button
                type="button"
                size="sm"
                variant={target() === option.id ? "outline" : "quiet"}
                onClick={() => setTarget(option.id as "here" | "named" | "new")}
              >
                {option.label}
              </Button>
            )}
          </For>
        </div>
        <Show when={target() === "named"}>
          <TextField class="mt-2">
            <TextFieldLabel>{t("schedule.panel.sessionId")}</TextFieldLabel>
            <TextFieldInput
              size="sm"
              value={sessionId()}
              placeholder="opencode:…"
              onInput={(e) => setSessionId(e.currentTarget.value)}
            />
          </TextField>
          <p class="mt-1 text-2xs text-muted-foreground">{t("schedule.panel.workspaceOnly")}</p>
        </Show>

        <div class="mt-2 flex gap-1">
          <Button type="button" size="sm" disabled={busy()} onClick={() => void submit()}>
            {editing() ? t("schedule.panel.save") : t("schedule.panel.create")}
          </Button>
          <Show when={editing()}>
            <Button type="button" size="sm" variant="quiet" onClick={reset}>
              {t("schedule.panel.cancel")}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  );
}
