import { createEffect, createSignal, on, Show } from "solid-js";
import { clearGoal, setGoal } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Set or clear the goal the service continues when this session goes idle. */
export function useGoal(sessionId: () => string, goal: () => string | undefined) {
  const [draft, setDraft] = createSignal("");
  const [err, setErr] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  // The view arrives a beat after the write. Hold the text we just saved so
  // the strip does not collapse back to "set a goal" in that gap.
  const [held, setHeld] = createSignal<string | null>(null);
  const shown = () => (held() === null ? goal() : held() || undefined);

  createEffect(() => {
    const incoming = goal() ?? "";
    if (held() === incoming || (held() === "" && !goal())) setHeld(null);
  });

  // The composer can be re-pointed at another session without remounting;
  // nothing the old session left behind belongs in the new one's editor.
  createEffect(
    on(
      sessionId,
      () => {
        setHeld(null);
        setErr("");
        setOpen(false);
        setDraft("");
      },
      { defer: true },
    ),
  );

  const openEditor = () => {
    setDraft(shown() ?? "");
    setErr("");
    setOpen(true);
  };

  const save = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    setBusy(true);
    setErr("");
    try {
      await setGoal(sessionId(), text);
      setHeld(text);
      setOpen(false);
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
      await clearGoal(sessionId());
      setHeld("");
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("goal.err"));
    } finally {
      setBusy(false);
    }
  };

  return { draft, setDraft, err, busy, open, setOpen, shown, openEditor, save, remove };
}

export type GoalCtl = ReturnType<typeof useGoal>;

/**
 * The composer's goal button: a target glyph beside attach and auto-accept,
 * opening the editor as a popover above the toolbar.
 */
export function GoalButton(props: { g: GoalCtl }) {
  const g = () => props.g;
  let area: HTMLTextAreaElement | undefined;
  return (
    <Popover
      open={g().open()}
      onOpenChange={(o) => (o ? g().openEditor() : g().setOpen(false))}
      gutter={8}
      placement="top-start"
    >
      <Tip label={g().shown() ? t("goal.edit_tip") : t("goal.set")} disabled={g().open()}>
        <PopoverTrigger
          class={`grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-secondary ${
            g().shown() ? "text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
          aria-pressed={Boolean(g().shown())}
          aria-label={t("goal.label")}
        >
          <Icon name="target" class="size-4" />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        class="w-80 p-3"
        aria-label={t("goal.label")}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          area?.focus();
        }}
      >
        <div class="flex items-center gap-1.5">
          <Icon name="target" class="size-3.5 text-primary" />
          <span class="text-xs font-medium">{t("goal.label")}</span>
        </div>
        <textarea
          ref={area}
          rows={3}
          class="mt-2 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus:border-ring focus:outline-none"
          value={g().draft()}
          placeholder={t("goal.placeholder")}
          aria-label={t("goal.label")}
          disabled={g().busy()}
          onInput={(e) => g().setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // 229: the key went to the IME, which some webviews report without isComposing.
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void g().save();
            }
          }}
        />
        <p class="mt-2 text-2xs leading-4 text-muted-foreground">{t("goal.hint")}</p>
        <Show when={g().err()}>
          <p class="mt-2 text-2xs text-destructive">{g().err()}</p>
        </Show>
        <div class="mt-3 flex items-center gap-2">
          <Show when={g().shown()}>
            <Button
              type="button"
              size="xs"
              variant="quiet"
              class="text-destructive hover:text-destructive"
              disabled={g().busy()}
              onClick={() => void g().remove()}
            >
              {t("goal.clear")}
            </Button>
          </Show>
          <Button
            type="button"
            size="xs"
            variant="quiet"
            class="ml-auto"
            onClick={() => g().setOpen(false)}
          >
            {t("goal.cancel")}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={g().busy() || !g().draft().trim()}
            onClick={() => void g().save()}
          >
            {g().shown() ? t("goal.update") : t("goal.save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The goal as a strip attached to the top of the composer, in the same family
 * as the plan and queued strips it stacks with.
 */
export function GoalStrip(props: { g: GoalCtl }) {
  const g = () => props.g;
  return (
    <Show when={g().shown()}>
      {(text) => (
        <div class="expand-in rounded-t-2xl border border-b-0 border-input bg-secondary/70 px-3 pb-4 pt-2">
          <div class="flex items-center gap-2">
            <Icon name="target" class="size-3.5 shrink-0 text-primary" />
            <span class="shrink-0 text-2xs font-medium text-muted-foreground">{t("goal.label")}</span>
            <Tip label={text()} class="min-w-0 flex-1">
              <Button
                type="button"
                variant="quiet"
                class="h-auto min-w-0 flex-1 justify-start px-0 py-0 font-normal"
                onClick={() => g().openEditor()}
              >
                <span class="truncate text-xs text-foreground/80">{text()}</span>
              </Button>
            </Tip>
            <Button
              type="button"
              size="icon-2xs"
              variant="icon"
              class="shrink-0 hover:bg-background"
              aria-label={t("goal.clear_aria")}
              disabled={g().busy()}
              onClick={() => void g().remove()}
            >
              <Icon name="x" class="size-3" />
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}
