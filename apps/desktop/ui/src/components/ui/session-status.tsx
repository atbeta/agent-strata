import { Show, splitProps } from "solid-js";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { showsDot, type SessionStatus } from "@/session-status";

/**
 * A session's state, drawn the way the rest of the app draws state: a dot, and
 * the word beside it only when the word is worth the row width.
 *
 * The sidebar and the fleet list each had their own version of this. The
 * sidebar had a six-pixel dot with no name on it anywhere — nothing to hover,
 * nothing for a screen reader — and the fleet list had a badge that called the
 * same session 待处理 in one place and 进行中 in another for two states that are
 * not the same. Both now read `sessionStatus()` and draw this.
 *
 * `status` is passed in already resolved rather than looked up here, so the
 * decision about *which* state a row is in stays in one tested function and
 * this stays a drawing.
 */
export function SessionStatusMark(props: { status: SessionStatus; class?: string }) {
  const [local, rest] = splitProps(props, ["status", "class"]);
  const s = () => local.status;
  /* relative keeps the sr-only label's containing block on this mark.
     Without it an auto-offset absolute element picks a higher positioned
     ancestor (the pane), skips the scroll container's clip, and leaks a 1px
     box that extends the document's scroll height. */
  return (
    <span class={cn("relative inline-flex shrink-0 items-center gap-1.5", local.class)} {...rest}>
      <Show when={showsDot(s())}>
        <span
          class={cn("h-1.5 w-1.5 rounded-full", s().tone.dot, s().pulse && "motion-safe:animate-pulse")}
          aria-hidden="true"
        />
      </Show>
      <Show when={s().badge}>
        <span
          class={cn("rounded px-1 text-2xs font-medium leading-none", s().tone.chip, s().tone.text)}
        >
          {t(s().label)}
        </span>
      </Show>
      {/* Without a badge the dot alone says nothing to a screen reader. Idle,
          stopped and done are that case: the dot is there, the word is not. */}
      <Show when={!s().badge}>
        <span class="sr-only">{t(s().label)}</span>
      </Show>
    </span>
  );
}
