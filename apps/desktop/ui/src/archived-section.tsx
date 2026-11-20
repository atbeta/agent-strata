import { createSignal, For, Show } from "solid-js";
import { folderLabel, type SessionRow } from "./api";
import type { SessionListCtl } from "./use-session-list";
import { deleteSession, readSessionData, unarchiveSession, type SessionData } from "./maintenance-api";
import { displayTitle } from "./session-title";
import { relTime } from "./fleet";
import { explain, fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { Tip } from "@/tip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RowButton } from "@/components/ui/row-button";
import { visibleArchiveNote } from "./archived-note";
import { archivedDeleteWarning } from "./archived-warning";

/**
 * Archived sessions, in a fixed band at the foot of the rail.
 *
 * They are folded away by default — an archived conversation is not part of the
 * working set — and the fold sits below the working list, above the
 * connections, so it is an entry and not a section. It is a band of its own
 * rather than the last item of the list: inside the list it sank below every
 * project and every session the reader had, and a place you have to scroll to
 * the end to find is not a place. The band stays even when nothing is
 * archived, and reports zero — the same rule as the counts at the top of the
 * rail, where a count that says zero is an answer and a count that comes and
 * goes is not. Restoring one stays here, because that is a session action, not
 * database upkeep. Deleting one says what the two halves mean before it
 * happens: the backend copy and the local record, and how many local-only
 * facts cannot be rebuilt.
 */
export function ArchivedSection(props: {
  list: SessionListCtl;
  now: () => number;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal("");
  const [note, setNote] = fadeSignal<{ id: string; text: string } | undefined>(undefined);
  const [error, setError] = fadeSignal("");
  const [confirm, setConfirm] = createSignal<{ row: SessionRow; data: SessionData }>();

  const rows = () => props.list.archived();
  const noteText = () => visibleArchiveNote(note(), rows().map((row) => row.summary.session_id));
  const askDelete = async (row: SessionRow) => {
    const id = row.summary.session_id;
    setBusy(id);
    setError("");
    try {
      const data = await readSessionData(id);
      setConfirm({ row, data });
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy("");
    }
  };
  const restore = async (row: SessionRow) => {
    const id = row.summary.session_id;
    setBusy(id);
    setError("");
    setNote(undefined);
    try {
      await unarchiveSession(id);
      setNote({ id, text: t("sidebar.archived.restored") });
      void props.list.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy("");
    }
  };
  const remove = async (row: SessionRow, data: SessionData) => {
    const id = row.summary.session_id;
    setBusy(id);
    setError("");
    setNote(undefined);
    try {
      await deleteSession(id, !data.can_delete);
      setConfirm(undefined);
      setNote({ id, text: t("sidebar.archived.deleted") });
      void props.list.refetch();
    } catch (e) {
      setConfirm(undefined);
      setError(explain(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="shrink-0 border-t border-border px-2 py-1">
      <RowButton
        class="h-6 items-center gap-1.5 px-1 text-2xs text-faint-foreground hover:text-muted-foreground"
        aria-expanded={open()}
        onClick={() => setOpen((on) => !on)}
      >
        <Icon name="archive" class="size-3 shrink-0 text-faint-foreground" />
        <span class="truncate">{t("sidebar.archived", { n: rows().length })}</span>
        <Icon
          name="chevron"
          class={`ml-auto size-3 shrink-0 text-faint-foreground transition-transform ${
            open() ? "" : "-rotate-90"
          }`}
        />
      </RowButton>
      <Show when={open()}>
        <ul class="mt-1 max-h-72 space-y-0.5 overflow-y-auto pr-0.5">
          <For each={rows()}>
            {(row) => {
              const id = row.summary.session_id;
              const title = () => displayTitle(row.title ?? row.summary.title) ?? t("common.untitled");
              const folder = () => folderLabel(row.workspace ?? row.summary.workspace);
              // The date holds the slot until the row is pointed at or focused;
              // a row in the middle of a request keeps the actions visible but
              // disabled.
              const held = () => busy() === id;
              return (
                <li>
                  <div class="group/arch relative flex items-center">
                    <RowButton
                      class="min-w-0 flex-1 gap-2 px-1 py-1 text-sm text-muted-foreground hover:text-foreground"
                      title={folder() ? `${title()} · ${folder()}` : title()}
                      onClick={() => props.onOpen(id)}
                    >
                      <span class="min-w-0 flex-1 truncate">{title()}</span>
                      <span
                        class={`shrink-0 font-mono text-2xs text-faint-foreground tabular-nums group-hover/arch:invisible group-focus-within/arch:invisible ${
                          held() ? "invisible" : ""
                        }`}
                      >
                        {relTime(row.summary.last_ts, props.now())}
                      </span>
                    </RowButton>
                    <div
                      class={`absolute inset-y-0 right-0 flex items-center gap-0.5 bg-sidebar pl-1 transition-opacity group-hover/arch:opacity-100 group-focus-within/arch:opacity-100 ${
                        held() ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <Tip label={t("sidebar.archived.restore")}>
                        <Button
                          type="button"
                          size="icon-2xs"
                          variant="icon"
                          class="shrink-0"
                          aria-label={t("sidebar.archived.restore")}
                          disabled={busy() === id}
                          onClick={() => void restore(row)}
                        >
                          <Icon name="undo" class="size-3" />
                        </Button>
                      </Tip>
                      <Tip label={t("sidebar.archived.delete")}>
                        <Button
                          type="button"
                          size="icon-2xs"
                          variant="icon"
                          class="shrink-0 hover:text-destructive"
                          aria-label={t("sidebar.archived.delete")}
                          disabled={busy() === id}
                          onClick={() => void askDelete(row)}
                        >
                          <Icon name="trash" class="size-3" />
                        </Button>
                      </Tip>
                    </div>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={noteText()}>
          <p class="px-1 pt-1 text-2xs text-muted-foreground">{noteText()}</p>
        </Show>
        <Show when={error()}>
          <p class="px-1 pt-1 text-2xs text-destructive">{error()}</p>
        </Show>
      </Show>
      <ConfirmDialog
        open={confirm() !== undefined}
        title={t("sidebar.session.deleteTitle", {
          name: confirm()
            ? (displayTitle(confirm()!.row.title ?? confirm()!.row.summary.title) ?? t("common.untitled"))
            : "",
        })}
        description={confirm() ? archivedDeleteWarning(confirm()!.data) : ""}
        confirmLabel={
          confirm()?.data.can_delete ? t("sidebar.archived.confirm") : t("sidebar.archived.localConfirm")
        }
        cancelLabel={t("confirm.cancel")}
        pending={busy() === confirm()?.row.summary.session_id}
        onConfirm={() => {
          const target = confirm();
          if (target) void remove(target.row, target.data);
        }}
        onCancel={() => {
          if (busy() !== confirm()?.row.summary.session_id) setConfirm(undefined);
        }}
      />
    </div>
  );
}
