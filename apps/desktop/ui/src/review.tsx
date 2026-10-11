import { createEffect, createSignal, For, Show } from "solid-js";
import type { ReviewDiff } from "./api";
import { t } from "./i18n";
import { splitPatch, type SplitCell, type SplitRow } from "./split-patch";

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function cellClass(kind: SplitCell["kind"]): string {
  if (kind === "add") return "bg-diff-add-bg text-diff-add-fg";
  if (kind === "del") return "bg-diff-del-bg text-diff-del-fg";
  if (kind === "empty") return "";
  return "text-muted-foreground";
}

/**
 * One OpenCode diff (the session, one reply, or git) as a file list plus the
 * patch. A line click hands the composer a citation; the reader writes the
 * comment there.
 *
 * The unified/split switch lives here rather than in the rail's tab strip. It
 * used to render only on some tabs, so the strip grew from five controls to
 * seven and back on every click — a control bar that reshapes itself is worse
 * than one that does not. This way the tab strip never changes, and the switch
 * sits with the thing it controls.
 */
export function ReviewPane(props: {
  files: ReviewDiff[];
  layout: "unified" | "split";
  onLayout: (next: "unified" | "split") => void;
  onComment: (note: string) => void;
}) {
  const named = () => props.files.filter((f) => f.file);
  const [selected, setSelected] = createSignal<string | null>(null);
  createEffect(() => {
    const files = named();
    if (!files.some((f) => f.file === selected())) setSelected(files[0]?.file ?? null);
  });
  const current = () => named().find((f) => f.file === selected()) ?? null;

  const cite = (file: string, cell: SplitCell) => {
    if (cell.line === undefined) return;
    const key = cell.kind === "del" ? "review.cite.removed" : "review.cite";
    props.onComment(t(key, { file, line: cell.line }));
  };

  const unified = (rows: SplitRow[]): SplitCell[] => {
    const lines: SplitCell[] = [];
    for (const row of rows) {
      if (row.kind === "hunk") continue;
      const { left, right } = row;
      if (left.kind === "ctx") lines.push(right.kind === "ctx" ? right : left);
      else if (left.kind === "del") lines.push(left);
      if (right.kind === "add") lines.push(right);
    }
    return lines;
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {(["unified", "split"] as const).map((id) => (
          <button
            type="button"
            class={`rounded-md px-1.5 py-0.5 text-2xs ${
              props.layout === id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
            aria-pressed={props.layout === id}
            onClick={() => props.onLayout(id)}
          >
            {t(id === "unified" ? "review.unified" : "review.split")}
          </button>
        ))}
      </div>
      <div class="flex min-h-0 flex-1">
      <ul class="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-border px-2 py-2">
        <For each={named()}>
          {(f) => (
            <li>
              <button
                type="button"
                class={`flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-secondary ${
                  selected() === f.file ? "bg-secondary" : ""
                }`}
                onClick={() => setSelected(f.file!)}
              >
                <span class="min-w-0 flex-1 truncate text-sm" title={f.file}>
                  {baseName(f.file!)}
                </span>
                <span class="shrink-0 font-mono text-2xs">
                  <span class="text-diff-add-fg">+{f.additions}</span>{" "}
                  <span class="text-diff-del-fg">−{f.deletions}</span>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-2">
        <Show
          when={current()?.patch}
          fallback={<p class="text-xs text-muted-foreground">{t("file.noDiff")}</p>}
        >
          {(patch) => (
            <Show
              when={props.layout === "split"}
              fallback={
                <div class="w-max font-mono text-2xs leading-relaxed">
                  <For each={unified(splitPatch(patch()))}>
                    {(cell) => <Line file={current()!.file!} cell={cell} onCite={cite} />}
                  </For>
                </div>
              }
            >
              <div class="w-max font-mono text-2xs leading-relaxed">
                <For each={splitPatch(patch())}>
                  {(row) => (
                    <Show
                      when={row.kind === "pair" ? row : undefined}
                      fallback={<div class="text-muted-foreground">{row.kind === "hunk" ? row.text : ""}</div>}
                    >
                      {(pair) => (
                        <div class="grid grid-cols-2">
                          <Line file={current()!.file!} cell={pair().left} onCite={cite} />
                          <Line file={current()!.file!} cell={pair().right} onCite={cite} />
                        </div>
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
      </div>
    </div>
  );
}

function Line(props: {
  file: string;
  cell: SplitCell;
  onCite: (file: string, cell: SplitCell) => void;
}) {
  const mark = () => (props.cell.kind === "add" ? "+" : props.cell.kind === "del" ? "-" : " ");
  return (
    <Show
      when={props.cell.kind !== "empty" && props.cell.line !== undefined}
      fallback={<span class={`block min-h-[1.25rem] px-1 ${cellClass(props.cell.kind)}`}> </span>}
    >
      <button
        type="button"
        class={`block w-full whitespace-pre px-1 text-left hover:outline hover:outline-1 hover:outline-ring ${cellClass(props.cell.kind)}`}
        aria-label={t("review.comment")}
        onClick={() => props.onCite(props.file, props.cell)}
      >
        {mark()}
        {props.cell.text || " "}
      </button>
    </Show>
  );
}
