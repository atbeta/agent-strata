import { For, Show } from "solid-js";
import { SessionStatusMark } from "@/components/ui/session-status";
import { Button } from "@/components/ui/button";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { sessionStatus } from "./session-status";
import { childBoardRows, type ChildBoardRow } from "./session-tree";

type BoardSession = ChildBoardRow & {
  title?: string | null;
  summary: { session_id: string; title?: string | null; last_ts?: string };
};

/** How many chips fit before the rest collapse into a count. Waiting sorts first, so the ones that need a person stay on screen. */
const SHOWN = 8;

/**
 * The sessions this one opened, as a strip under its header.
 *
 * The sidebar hides them on purpose. The task card in the transcript names
 * the one call that opened a child, and a session can open several. This is
 * the list of those children, in the parent the reader is already looking at.
 */
export function ChildBoard(props: { parentId: string; sessions: readonly BoardSession[] }) {
  const rows = () => childBoardRows(props.sessions, props.parentId);
  const shown = () => rows().slice(0, SHOWN);
  const rest = () => Math.max(0, rows().length - SHOWN);
  return (
    <Show when={rows().length > 0}>
      <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1">
        <span class="shrink-0 text-2xs text-muted-foreground">{t("children.label", { n: rows().length })}</span>
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <For each={shown()}>
            {(row) => {
              const title = () => displayTitle(row.title || row.summary.title) ?? t("session.untitled");
              return (
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  class="h-5 max-w-44 shrink-0 gap-1 px-1.5 font-normal"
                  aria-label={t("children.open", { title: title() })}
                  onClick={() => {
                    location.hash = `/session/${encodeURIComponent(row.summary.session_id)}`;
                  }}
                >
                  <SessionStatusMark status={sessionStatus(row)} />
                  <span class="truncate">{title()}</span>
                </Button>
              );
            }}
          </For>
          <Show when={rest() > 0}>
            <span class="shrink-0 text-2xs text-muted-foreground">{t("children.more", { n: rest() })}</span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
