import { createSignal, For, Show } from "solid-js";
import type { SessionRow } from "./api";
import type { SessionListCtl } from "./use-session-list";
import { deleteSession, readSessionData, unarchiveSession, type SessionData } from "./maintenance-api";
import { displayTitle } from "./session-title";
import { relTime } from "./fleet";
import { explain } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";

/**
 * Archived sessions where a session belongs: the sidebar.
 *
 * They are folded away by default — an archived conversation is not part of the
 * working set — but they are not in a settings page either, because restoring
 * one is a session action, not database upkeep. Deleting one says what the two
 * halves mean before it happens: the backend copy and the local record, and how
 * many local-only facts cannot be rebuilt.
 */
export function ArchivedSection(props: {
  list: SessionListCtl;
  now: () => number;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [confirm, setConfirm] = createSignal<{ row: SessionRow; data: SessionData }>();

  const rows = () => props.list.archived();
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
    setMessage("");
    try {
      await unarchiveSession(id);
      setMessage(t("sidebar.archived.restored"));
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
    setMessage("");
    try {
      await deleteSession(id, !data.can_delete);
      setConfirm(undefined);
      setMessage(t("sidebar.archived.deleted"));
      void props.list.refetch();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <Show when={rows().length > 0}>
      <div class="mt-1 border-t border-border px-2 pb-1 pt-1.5">
        <RowButton
          class="h-7 items-center gap-2 px-1 text-xs text-muted-foreground hover:bg-accent/70"
          aria-expanded={open()}
          onClick={() => setOpen((on) => !on)}
        >
          <Icon name="archive" class="size-3.5 shrink-0 text-muted-foreground/70" />
          <span class="truncate">{t("sidebar.archived", { n: rows().length })}</span>
          <Icon
            name="chevron"
            class={`ml-auto size-3 shrink-0 text-muted-foreground/60 transition-transform ${
              open() ? "" : "-rotate-90"
            }`}
          />
        </RowButton>
        <Show when={open()}>
          <ul class="mt-1 space-y-0.5">
            <For each={rows()}>
              {(row) => {
                const id = row.summary.session_id;
                const pending = () => confirm()?.row.summary.session_id === id;
                return (
                  <li>
                    <div class="flex items-center gap-1">
                      <RowButton
                        class="min-w-0 flex-1 px-1 py-1 text-sm"
                        title={displayTitle(row.title ?? row.summary.title) ?? t("common.untitled")}
                        onClick={() => props.onOpen(id)}
                      >
                        <span class="min-w-0 flex-1 truncate">
                          {displayTitle(row.title ?? row.summary.title) ?? t("common.untitled")}
                        </span>
                      </RowButton>
                      <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                        {relTime(row.summary.last_ts, props.now())}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="quiet"
                        class="shrink-0 px-1.5"
                        disabled={busy() === id}
                        onClick={() => void restore(row)}
                      >
                        {t("sidebar.archived.restore")}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="quiet"
                        class="shrink-0 px-1.5 text-muted-foreground"
                        disabled={busy() === id}
                        onClick={() => void askDelete(row)}
                      >
                        {t("sidebar.archived.delete")}
                      </Button>
                    </div>
                    <Show when={pending() ? confirm() : undefined}>
                      {(target) => (
                        <div class="mx-1 mt-1 rounded-md border border-border bg-secondary/40 px-2 py-1.5">
                          <p class="text-2xs leading-4 text-muted-foreground">
                            {target().data.can_delete
                              ? t("sidebar.archived.warning", { local: target().data.local })
                              : t("sidebar.archived.localOnly")}
                          </p>
                          <div class="mt-1 flex justify-end gap-1">
                            <Button
                              type="button"
                              size="xs"
                              variant="quiet"
                              onClick={() => setConfirm(undefined)}
                            >
                              {t("sidebar.archived.cancel")}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="quiet"
                              class="text-destructive"
                              disabled={busy() === id}
                              onClick={() => void remove(row, target().data)}
                            >
                              {target().data.can_delete
                                ? t("sidebar.archived.confirm")
                                : t("sidebar.archived.localConfirm")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={message()}>
            <p class="px-1 pt-1 text-2xs text-muted-foreground">{message()}</p>
          </Show>
          <Show when={error()}>
            <p class="px-1 pt-1 text-2xs text-destructive">{error()}</p>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
