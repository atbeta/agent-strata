import { createEffect, createSignal, Show } from "solid-js";
import { clearGoal, setGoal } from "./api";
import { Button } from "./components/ui/button";
import { TextFieldInput } from "./components/ui/text-field";
import { t } from "./i18n";

/** Set or clear the goal the service continues when this session goes idle. */
export function GoalBar(props: { sessionId: string; goal?: string }) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // The view arrives a beat after the write. Hold the text we just saved so
  // the row does not collapse back to "set a goal" in that gap.
  const [held, setHeld] = createSignal<string | null>(null);
  const shown = () => (held() === null ? props.goal : held() || undefined);

  createEffect(() => {
    const incoming = props.goal ?? "";
    if (held() === incoming || (held() === "" && !props.goal)) setHeld(null);
  });

  const save = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    setBusy(true);
    setErr("");
    try {
      await setGoal(props.sessionId, text);
      setHeld(text);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("goal.err"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy()) return;
    setBusy(true);
    setErr("");
    try {
      await clearGoal(props.sessionId);
      setHeld("");
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("goal.err"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="px-1">
      <Show
        when={shown() || editing()}
        fallback={
          <Button
            type="button"
            size="xs"
            variant="quiet"
            onClick={() => {
              setDraft("");
              setErr("");
              setEditing(true);
            }}
          >
            {t("goal.set")}
          </Button>
        }
      >
        <Show
          when={editing()}
          fallback={
            <div class="flex items-start gap-2">
              <p class="min-w-0 flex-1 text-2xs leading-4 text-muted-foreground">
                <span class="text-foreground">{t("goal.label")}</span>
                {" "}
                {shown()}
              </p>
              <Button
                type="button"
                size="xs"
                variant="quiet"
                class="shrink-0"
                onClick={() => {
                  setDraft(shown() ?? "");
                  setErr("");
                  setEditing(true);
                }}
              >
                {t("goal.edit")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="quiet"
                class="shrink-0"
                disabled={busy()}
                onClick={() => void remove()}
              >
                {t("goal.clear")}
              </Button>
            </div>
          }
        >
          <form
            class="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <TextFieldInput
              bare
              size="sm"
              class="min-w-0 flex-1"
              value={draft()}
              placeholder={t("goal.placeholder")}
              aria-label={t("goal.label")}
              disabled={busy()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <Button type="submit" size="xs" variant="quiet" disabled={busy() || !draft().trim()}>
              {t("goal.save")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="quiet"
              disabled={busy()}
              onClick={() => setEditing(false)}
            >
              {t("goal.cancel")}
            </Button>
          </form>
          <p class="mt-1 text-2xs leading-4 text-muted-foreground">{t("goal.hint")}</p>
        </Show>
      </Show>
      <Show when={err()}>
        <p class="mt-1 text-2xs text-destructive">{err()}</p>
      </Show>
    </div>
  );
}
