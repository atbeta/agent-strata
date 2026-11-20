import { Show } from "solid-js";
import { RowButton } from "@/components/ui/row-button";
import { num, t, tn } from "./i18n";

export type ChangeKind = "add" | "delete" | "modify";

function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

function changeWord(change: ChangeKind): string {
  if (change === "add") return t("file.added");
  if (change === "delete") return t("file.deleted");
  return t("file.edited");
}

export function ChangeFileRow(props: {
  path: string;
  change?: ChangeKind;
  selected: boolean;
  expanded?: boolean;
  changeCount?: number;
  additions: number;
  deletions: number;
  unexplained?: boolean;
  onClick: () => void;
}) {
  const status = () => (props.change ? changeWord(props.change) : undefined);
  return (
    <RowButton
      aria-expanded={props.expanded}
      aria-current={props.selected ? "true" : undefined}
      aria-label={status() ? `${props.path}, ${status()}` : props.path}
      onClick={props.onClick}
      title={status() ? `${props.path} · ${status()}` : props.path}
      class={`items-baseline gap-2 px-2 py-1.5 ${props.selected ? "bg-accent text-foreground" : ""}`}
    >
      <Show when={props.change}>
        {(change) => (
          <span
            class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              change() === "add"
                ? "bg-status-active"
                : change() === "delete"
                  ? "bg-status-error"
                  : "bg-status-completed"
            }`}
            aria-hidden="true"
          />
        )}
      </Show>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm">{fileName(props.path)}</span>
        <Show when={(props.changeCount ?? 0) > 1}>
          <span class="block truncate text-2xs text-muted-foreground">
            {tn("file.changes", props.changeCount!)}
          </span>
        </Show>
      </span>
      <Show when={props.additions > 0 || props.deletions > 0}>
        <span
          class="shrink-0 font-mono text-2xs tabular-nums"
          title={props.unexplained ? t("file.partial") : undefined}
        >
          <span class="text-diff-add-fg">
            {props.unexplained ? "≥+" : "+"}
            {num(props.additions)}
          </span>{" "}
          <span class="text-diff-del-fg">−{num(props.deletions)}</span>
        </span>
      </Show>
    </RowButton>
  );
}
