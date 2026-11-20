import { createEffect, createSignal, For, Show } from "solid-js";
import type { ReviewDiff } from "./api";
import { t } from "./i18n";
import { splitPatch, type SplitCell, type SplitRow } from "./split-patch";
import { ChangeFileRow, type ChangeKind } from "./change-file-row";

function changeKind(status: NonNullable<ReviewDiff["status"]>): ChangeKind {
  if (status === "added") return "add";
  if (status === "deleted") return "delete";
  return "modify";
}

function cellClass(kind: SplitCell["kind"]): string {
  if (kind === "add") return "bg-diff-add-bg text-diff-add-fg";
  if (kind === "del") return "bg-diff-del-bg text-diff-del-fg";
  if (kind === "empty") return "";
  return "text-muted-foreground";
}

/** One repo diff as a file list plus the patch. A line click cites it in the composer. */
export function ReviewPane(props: {
  files: ReviewDiff[];
  layout: "unified" | "split";
  onComment: (note: string) => void;
}) {
  const named = () => props.files.filter((file) => file.file);
  const [selected, setSelected] = createSignal<string | null>(null);
  createEffect(() => {
    const files = named();
    if (!files.some((file) => file.file === selected())) setSelected(files[0]?.file ?? null);
  });
  const current = () => named().find((file) => file.file === selected()) ?? null;

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
    <div class="@container flex min-h-0 flex-1 flex-col">
      <div class="flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
      <ul class="max-h-[40%] shrink-0 space-y-0.5 overflow-y-auto border-b border-border px-2 py-2 @min-[560px]:max-h-none @min-[560px]:w-[clamp(200px,30%,280px)] @min-[560px]:border-b-0 @min-[560px]:border-r">
        <For each={named()}>
          {(file) => (
            <li>
              <ChangeFileRow
                path={file.file!}
                change={file.status ? changeKind(file.status) : undefined}
                selected={selected() === file.file}
                additions={file.additions}
                deletions={file.deletions}
                onClick={() => setSelected(file.file!)}
              />
            </li>
          )}
        </For>
      </ul>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Show when={current()?.file}>
          {(path) => (
            <div class="shrink-0 border-b border-border px-3 py-2 font-mono text-2xs break-words text-muted-foreground">
              {path()}
            </div>
          )}
        </Show>
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
