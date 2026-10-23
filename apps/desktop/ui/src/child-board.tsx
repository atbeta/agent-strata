import { createRenderEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { SessionStatusMark } from "@/components/ui/session-status";
import { RowButton } from "@/components/ui/row-button";
import { Icon } from "./icons";
import { t, tn } from "./i18n";
import { displayTitle } from "./session-title";
import { sessionStatus } from "./session-status";
import { Tip } from "./tip";
import {
  childBoardFold,
  childBoardRows,
  childBoardStartsOpen,
  type ChildBoardRow,
} from "./session-tree";

type BoardSession = ChildBoardRow & {
  title?: string | null;
  summary: { session_id: string; title?: string | null; last_ts?: string };
};

/**
 * Whether this parent's fold is open, remembered for the life of the window.
 *
 * `SessionDetail` stays mounted while the reader moves between sessions, so a
 * signal born inside this component would keep the previous session's choice.
 * The map is keyed by the parent, and an absent entry means the list itself
 * decides: open when a child is waiting, shut when it is only a count.
 */
const foldChoice = new Map<string, boolean>();

/**
 * The full name, on hover, only once the visible line has actually cut it.
 *
 * A title that already fits does not need a second copy floating over the
 * next row. The measurement is the element's own overflow, so a narrow pane
 * grows a tip and a wide one does not.
 */
function CutTitle(props: { text: string; clamp: "1" | "2"; class?: string }) {
  let el: HTMLSpanElement | undefined;
  const [cut, setCut] = createSignal(false);
  onMount(() => {
    const measure = () => {
      if (!el) return;
      setCut(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const obs = new ResizeObserver(measure);
    if (el) obs.observe(el);
    onCleanup(() => obs.disconnect());
  });
  return (
    <Tip label={props.text} disabled={!cut()} class={props.class}>
      <span
        ref={el}
        class={
          props.clamp === "1"
            ? "block w-full truncate text-left"
            : "line-clamp-2 w-full min-w-0 break-words text-left"
        }
      >
        {props.text}
      </span>
    </Tip>
  );
}

/**
 * The sessions this one opened, folded under its header.
 *
 * A chip row stays one line high by cutting every name off, and the names
 * that do not fit become a count you cannot open. The fold is one line until
 * it is asked for. Open, each child is its own row: the title wraps, and
 * hovering it shows the whole name. The sidebar still hides these sessions;
 * this is the list in the parent the reader is already looking at.
 */
export function ChildBoard(props: { parentId: string; sessions: readonly BoardSession[] }) {
  const rows = () => childBoardRows(props.sessions, props.parentId);
  const fold = () => childBoardFold(rows());
  const [open, setOpen] = createSignal(false);
  const titleOf = (row: BoardSession) =>
    displayTitle(row.title || row.summary.title) ?? t("session.untitled");
  const preview = () => {
    const id = fold().previewId;
    const row = id ? rows().find((item) => item.summary.session_id === id) : undefined;
    return row ? titleOf(row) : undefined;
  };

  createRenderEffect(() => {
    const id = props.parentId;
    const stored = foldChoice.get(id);
    if (stored !== undefined) {
      setOpen(stored);
      return;
    }
    setOpen(childBoardStartsOpen(rows()));
  });

  const toggle = () => {
    const next = !open();
    foldChoice.set(props.parentId, next);
    setOpen(next);
  };

  let details: HTMLDetailsElement | undefined;
  createRenderEffect(() => {
    const next = open();
    if (details) details.open = next;
  });

  return (
    <Show when={rows().length > 0}>
      <details
        ref={(el) => {
          details = el;
          el.open = open();
        }}
        class="shrink-0 border-b border-border"
      >
        <summary
          class="flex cursor-pointer list-none items-center gap-1.5 px-4 py-1.5 text-2xs text-muted-foreground select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden [&::marker]:content-none"
          onClick={(event) => {
            event.preventDefault();
            toggle();
          }}
        >
          <Icon
            name="chevron"
            class={`size-3 shrink-0 text-muted-foreground/60 transition-transform ${open() ? "" : "-rotate-90"}`}
          />
          <span class="shrink-0">{t("children.label", { n: rows().length })}</span>
          <Show when={!open() && fold().waiting > 0}>
            <span class="shrink-0 text-event-permission">{tn("children.waiting", fold().waiting)}</span>
          </Show>
          <Show when={!open() && fold().waiting === 0 && fold().running > 0}>
            <span class="shrink-0 text-status-active">{tn("children.running", fold().running)}</span>
          </Show>
          <Show when={!open() && preview()}>
            {(name) => <CutTitle text={name()} clamp="1" class="min-w-0 flex-1" />}
          </Show>
        </summary>
        <ul class="max-h-64 overflow-y-auto px-2 pb-1.5">
          <For each={rows()}>
            {(row) => {
              const title = () => titleOf(row);
              return (
                <li class="min-w-0">
                  <RowButton
                    class="h-auto min-w-0 items-start gap-2 whitespace-normal py-1"
                    aria-label={t("children.open", { title: title() })}
                    onClick={() => {
                      location.hash = `/session/${encodeURIComponent(row.summary.session_id)}`;
                    }}
                  >
                    <SessionStatusMark class="mt-1" status={sessionStatus(row)} />
                    <CutTitle text={title()} clamp="2" class="min-w-0 flex-1" />
                  </RowButton>
                </li>
              );
            }}
          </For>
        </ul>
      </details>
    </Show>
  );
}
