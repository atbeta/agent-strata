import { Show, type JSX } from "solid-js";
import { folderLabel, realWorkspace } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";

/**
 * What a session with nothing in it says about itself.
 *
 * This used to be a generic `EmptyState` — a grey spark bubble and two lines
 * that told the reader the same thing twice. A fresh session is not an
 * absence that needs excusing; it is a place, so the place is what it says:
 * the folder it runs in, the branch it sits on.
 *
 * Where a composer is attached the caller passes `hints` and the block names
 * the few keys that are not obvious — `@` to mention a file, `/` for
 * commands, shift-enter for a newline. Peer panes have no composer, so they
 * pass no hints and get a quieter line instead of keys that would not work
 * there.
 */
export function SessionEmpty(props: {
  workspace?: string | null;
  branch?: string | null;
  /** Composer affordances worth naming; undefined marks a pane with no composer. */
  hints?: { mention: boolean; command: boolean };
}) {
  const real = () => realWorkspace(props.workspace);
  return (
    <div
      class="flex w-full max-w-full flex-col items-center text-center"
      role="status"
      aria-live="polite"
    >
      <p class="text-lg font-medium text-foreground">
        {real() ? folderLabel(real()) : t("session.empty.fresh")}
      </p>
      <Show when={real()}>
        {(ws) => (
          <p class="mt-1 flex max-w-full items-center gap-2 font-mono text-2xs text-muted-foreground">
            <span class="min-w-0 truncate" title={ws()}>
              {ws()}
            </span>
            <Show when={props.branch}>
              <span class="shrink-0 text-muted-foreground/50">·</span>
              <Icon name="branch" class="size-3 shrink-0" />
              <span class="max-w-40 truncate">{props.branch}</span>
            </Show>
          </p>
        )}
      </Show>
      <Show
        when={props.hints}
        fallback={<p class="mt-3 text-xs text-muted-foreground">{t("session.empty.peer")}</p>}
      >
        {(hints) => (
          <div class="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <Show when={hints().mention}>
              <Hint keys="@">{t("session.empty.mention")}</Hint>
            </Show>
            <Show when={hints().command}>
              <Hint keys="/">{t("session.empty.command")}</Hint>
            </Show>
            <Hint keys="⇧ ↵">{t("session.empty.newline")}</Hint>
          </div>
        )}
      </Show>
    </div>
  );
}

function Hint(props: { keys: string; children: JSX.Element }) {
  return (
    <span class="inline-flex items-center gap-1.5">
      <kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-secondary/50 px-1.5 font-mono text-2xs text-foreground/80">
        {props.keys}
      </kbd>
      <span>{props.children}</span>
    </span>
  );
}
