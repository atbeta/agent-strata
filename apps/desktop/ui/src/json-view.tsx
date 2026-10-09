import { createSignal, For, Show } from "solid-js";
import { entriesOf, kindOf, summaryOf, type JsonKind } from "./structure";

/**
 * A collapsible tree for structured tool input/output.
 *
 * A tool result is JSON far more often than it is prose, and the raw string form
 * forces the reader to hold the whole shape in their head to find one value.
 * This renders the value instead of its serialisation: keyed rows, type-coloured
 * scalars, and containers that start open one level and close on demand.
 */

const SCALAR_CLS: Record<string, string> = {
  string: "text-status-active",
  number: "text-status-cancelled",
  boolean: "text-event-tool",
  null: "text-muted-foreground italic",
};

/** Branches shallower than this start open; anything deeper starts collapsed. */
const AUTO_OPEN = 1;
/** Past this depth a branch always renders collapsed — long arrays of objects
 *  are data to glance at, not to walk, and recursion has to terminate. */
const MAX_DEPTH = 12;

function Node(props: {
  label?: string;
  value: unknown;
  path: string;
  depth: number;
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string) => void;
}) {
  const kind = (): JsonKind => kindOf(props.value);
  const isBranch = () => kind() === "object" || kind() === "array";
  const entries = () => entriesOf(props.value);
  const count = () => entries().length;
  const expandable = () => isBranch() && count() > 0 && props.depth < MAX_DEPTH;
  const open = () => props.isOpen(props.path, props.depth);
  const summary = () => summaryOf(kind(), entries().map(([k]) => k));

  return (
    <div class="flex items-start gap-1 rounded-sm px-1 hover:bg-secondary/40">
      <Show
        when={expandable()}
        fallback={<span class="mt-px h-3.5 w-3.5 shrink-0" />}
      >
        <button
          type="button"
          class="mt-px grid h-3.5 w-3.5 shrink-0 place-items-center text-muted-foreground"
          aria-label={open() ? "折叠" : "展开"}
          aria-expanded={open()}
          onClick={() => props.toggle(props.path)}
        >
          <svg
            viewBox="0 0 8 8"
            class={`h-2 w-2 transition-transform ${open() ? "rotate-90" : ""}`}
            fill="currentColor"
          >
            <path d="M2 0.5 6 4 2 7.5z" />
          </svg>
        </button>
      </Show>

      <div class="min-w-0 flex-1 break-words">
        <Show when={props.label !== undefined}>
          <span class="text-event-user">{props.label}</span>
          <span class="text-muted-foreground">: </span>
        </Show>

        <Show
          when={expandable() && open()}
          fallback={
            <Show
              when={isBranch()}
              fallback={
                <span class={SCALAR_CLS[kind()] ?? "text-foreground"}>
                  {String(props.value)}
                </span>
              }
            >
              <button
                type="button"
                class="text-left text-muted-foreground hover:text-foreground"
                onClick={() => props.toggle(props.path)}
              >
                {summary()}
              </button>
            </Show>
          }
        >
          <span class="text-muted-foreground">{kind() === "array" ? "[" : "{"}</span>
          <div class="border-l border-border pl-2.5">
            <For each={entries()}>
              {([k, v]) => (
                <Node
                  label={k}
                  value={v}
                  path={`${props.path}.${k}`}
                  depth={props.depth + 1}
                  isOpen={props.isOpen}
                  toggle={props.toggle}
                />
              )}
            </For>
          </div>
          <span class="text-muted-foreground">{kind() === "array" ? "]" : "}"}</span>
        </Show>
      </div>
    </div>
  );
}

export function JsonView(props: { value: unknown; class?: string }) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());

  const isOpen = (path: string, depth: number) => open().has(path) || depth < AUTO_OPEN;

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div class={`font-mono text-xs leading-[1.55] ${props.class ?? ""}`}>
      <Node value={props.value} path="" depth={0} isOpen={isOpen} toggle={toggle} />
    </div>
  );
}