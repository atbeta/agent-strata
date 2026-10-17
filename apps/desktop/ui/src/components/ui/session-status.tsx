import { For, Show, splitProps } from "solid-js";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { showsMark, type SessionStatus } from "@/session-status";

/**
 * The working mark: a 5×5 pixel grid whose lit cells chase around the
 * perimeter. The same idea OpenCode draws with an animated sprite — a dim
 * dot-matrix with a bright arc sweeping the ring — done here as SVG cells
 * with staggered animation delays, so the mark tints itself from
 * `currentColor` and needs no image asset. Reduced-motion collapses to the
 * same faint grid with no sweep.
 *
 * Cells sit on a 3px pitch starting at 1, 2×2 each, in a 16×16 viewBox.
 * Ring order runs clockwise from the top-left so `--i` reads as the cell's
 * place in the chase.
 */
const RING: [number, number][] = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
  [4, 1], [4, 2], [4, 3], [4, 4],
  [3, 4], [2, 4], [1, 4], [0, 4],
  [0, 3], [0, 2], [0, 1],
];
const INNER: [number, number][] = [];
for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) INNER.push([x, y]);

function BusyGrid() {
  return (
    <svg
      viewBox="0 0 16 16"
      class="status-busy size-3 shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <For each={INNER}>
        {([x, y]) => <rect x={1 + x * 3} y={1 + y * 3} width="2" height="2" class="cell" />}
      </For>
      <For each={RING}>
        {([x, y], i) => (
          <rect
            x={1 + x * 3}
            y={1 + y * 3}
            width="2"
            height="2"
            class="cell cell-ring"
            style={{ "--i": i() }}
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
