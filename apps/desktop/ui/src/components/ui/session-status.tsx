import { For, Show, splitProps } from "solid-js";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { showsMark, type SessionStatus } from "@/session-status";

/**
 * The working mark, taken from OpenCode's spinner.
 *
 * A 4×4 matrix with the four corners left out, so it reads as a cluster
 * rather than a frame. The inner four breathe bright and the edge breathes
 * dim, on phases that are fixed for the whole window: every row beats the
 * same way, and a reload does not reshuffle them. A perimeter chase left the
 * middle sitting still, which is the hollow ring this replaced.
 *
 * Cells are 3×3 on a 4px pitch inside a 15×15 viewBox, corners rounded by 1
 * so they stay squares at sidebar size. The mark tints itself from
 * `currentColor`. Reduced motion keeps the same cells at their resting
 * opacity, with no pulse.
 */
const BUSY_CELLS: { x: number; y: number; dim: boolean; delay: number; duration: number }[] = [
  { x: 4, y: 0, dim: true, delay: 0.15, duration: 1.4 },
  { x: 8, y: 0, dim: true, delay: 0.9, duration: 1.7 },
  { x: 0, y: 4, dim: true, delay: 0.55, duration: 1.5 },
  { x: 4, y: 4, dim: false, delay: 0.0, duration: 1.6 },
  { x: 8, y: 4, dim: false, delay: 0.4, duration: 1.3 },
  { x: 12, y: 4, dim: true, delay: 1.1, duration: 1.8 },
  { x: 0, y: 8, dim: true, delay: 0.25, duration: 1.6 },
  { x: 4, y: 8, dim: false, delay: 0.7, duration: 1.4 },
  { x: 8, y: 8, dim: false, delay: 1.2, duration: 1.5 },
  { x: 12, y: 8, dim: true, delay: 0.45, duration: 1.7 },
  { x: 4, y: 12, dim: true, delay: 1.0, duration: 1.3 },
  { x: 8, y: 12, dim: true, delay: 0.3, duration: 1.8 },
];

function BusyGrid() {
  return (
    <svg
      viewBox="0 0 15 15"
      class="status-busy size-3 shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <For each={BUSY_CELLS}>
        {(cell) => (
          <rect
            x={cell.x}
            y={cell.y}
            width="3"
            height="3"
            rx="1"
            class={cell.dim ? "cell cell-dim" : "cell"}
            style={{ "--d": cell.delay, "--t": cell.duration }}
          />
        )}
      </For>
    </svg>
  );
}

/**
 * A session's state, drawn the way the rest of the app draws state: a mark,
 * and the word beside it only when the word is worth the row width.
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
      <Show
        when={s().kind === "running"}
        fallback={
          <Show when={showsMark(s())}>
            <span class={cn("h-1.5 w-1.5 rounded-full", s().tone.dot)} aria-hidden="true" />
          </Show>
        }
      >
        <BusyGrid />
      </Show>
      <Show when={s().badge}>
        <span
          class={cn("rounded px-1 text-2xs font-medium leading-none", s().tone.chip, s().tone.text)}
        >
          {t(s().label)}
        </span>
      </Show>
      {/* Without a badge the visible mark — or the lack of one — says nothing
          to a screen reader. Idle, stopped, done and running are that case. */}
      <Show when={!s().badge}>
        <span class="sr-only">{t(s().label)}</span>
      </Show>
    </span>
  );
}
