// The reader's side of the memory store.
//
// The agent writes these; the reader decides which of them are still true.
// Everything the agent remembered is visible here, with a switch that keeps an
// entry without injecting it, an editor, and a way to forget it entirely.
//
// The point of the page is trust: a memory the reader cannot see is a memory
// they cannot correct, and a stale one is worse than none.

import { createEffect, createSignal, For, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { t } from "./i18n";
import { Tip } from "./tip";
import {
  createMemory,
  deleteMemory,
  forgetMemories,
  listMemories,
  listMemoryWorkspaces,
  updateMemory,
  type MemoryEntry,
  type MemoryScope,
  type MemoryWorkspace,
} from "./memory-api";
import { registryVersion } from "./plugin-registry";

const GLOBAL = "global";
/**
 * A row of scopes is a switch you can see. Past this many it stops fitting the
 * card and becomes a list you open: the current scope stays on the button,
 * and the rest are a scrolling menu that names the directory and its path.
 */
const SCOPES_ON_A_ROW = 4;

export function MemorySettings(props: { disabled?: boolean; onEnable?: () => void }) {  const [workspaces, setWorkspaces] = createSignal<MemoryWorkspace[]>([]);
  const [scope, setScope] = createSignal<string>(GLOBAL);
  const [entries, setEntries] = createSignal<MemoryEntry[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [editing, setEditing] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [newText, setNewText] = createSignal("");
  const [forgetting, setForgetting] = createSignal<MemoryEntry | undefined>();
  /** Whether the reader asked to forget every entry, and in which scope. */
  const [clearing, setClearing] = createSignal<"" | MemoryScope | "all">("");
  /** Counts the reads, so a slow one cannot land on a scope nobody is on. */
  let loadToken = 0;
  /** Counts the workspace reads, so a slow one cannot land on a plugin that was turned off. */
  let workspaceToken = 0;

  /** Where the page is looking: everywhere, or one workspace. */
  const target = (): { scope: MemoryScope; workspace?: string } => {
    const id = scope();
    return id === GLOBAL ? { scope: "global" } : { scope: "workspace", workspace: id };
  };

  const label = (path: string): string => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  };

  const options = () => [
    { id: GLOBAL, label: t("plugin.memory.scope.global") },
    ...workspaces().map((workspace) => ({
      id: workspace.key,
      label: label(workspace.path),
      detail: workspace.path,
    })),
  ];

  const selectScope = (id: string) => {
    setScope(id);
    setEditing("");
    setAdding(false);
  };

  const load = async () => {
    const where = target();
    const token = ++loadToken;
    try {
      const list = await listMemories(where.scope, where.workspace);
      // A slow read for the scope the reader just left must not land on the
      // scope they are looking at now.
      if (token !== loadToken) return;
      setEntries(list);
      setError("");
    } catch (reason) {
      if (token !== loadToken) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // The workspaces come from the plugin, so they can only be read while it is
  // running — and the reader may turn it on from this very page. Reading them
  // once on mount would leave a page that was opened while the plugin was off
  // showing nothing but the Global tab, with the workspace memories unreachable
  // until it was reopened.
  createEffect(() => {
    // Every run of this effect invalidates the request before it, so a reply
    // that arrives after the plugin was turned off cannot paint an error on a
    // page that says the plugin is not running.
    const token = ++workspaceToken;
    if (props.disabled) return;
    void listMemoryWorkspaces()
      .then((rows) => {
        if (token !== workspaceToken) return;
        setWorkspaces(rows);
      })
      .catch((reason: unknown) => {
        if (token !== workspaceToken) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  });

  // The scope decides which file is read, and a plugin restart changes what is
  // in it — so both are reasons to read again.
  createEffect(() => {
    scope();
    registryVersion();
    if (props.disabled) {
      // The plugin answers no route now, so a read still in flight will fail.
      // It must not fail into a page that is telling the reader the plugin is
      // not running.
      loadToken += 1;
      return;
    }
    void load();
  });

  const replace = (entry: MemoryEntry) =>
    setEntries((rows) => rows.map((row) => (row.id === entry.id ? entry : row)));

  const toggle = async (entry: MemoryEntry, enabled: boolean) => {
    const where = target();
    setBusy(entry.id);
    setError("");
    try {
      replace(await updateMemory(where.scope, where.workspace, entry.id, { enabled }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const startEdit = (entry: MemoryEntry) => {
    setEditing(entry.id);
    setDraft(entry.text);
  };

  const save = async (entry: MemoryEntry) => {
    const where = target();
    const text = draft().trim();
    if (!text) return;
    setBusy(entry.id);
    setError("");
    try {
      replace(await updateMemory(where.scope, where.workspace, entry.id, { text }));
      setEditing("");
      setDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const add = async () => {
    const where = target();
    const text = newText().trim();
    if (!text) return;
    setBusy("add");
    setError("");
    try {
      const entry = await createMemory(where.scope, where.workspace, text);
      setEntries((rows) => [...rows, entry]);
      setNewText("");
      setAdding(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const forget = async (entry: MemoryEntry) => {
    const where = target();
    setBusy(entry.id);
    setError("");
    try {
      await deleteMemory(where.scope, where.workspace, entry.id);
      setEntries((rows) => rows.filter((row) => row.id !== entry.id));
      setForgetting(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  /**
   * Forget every entry, in this scope or in all of them.
   *
   * The file is emptied, not deleted, so the reader's own data directory
   * keeps its shape; what is gone is what the agent remembered.
   */
  const clear = async (which: "" | MemoryScope | "all") => {
    if (!which) return;
    const where = target();
    setBusy("clear");
    setError("");
    try {
      await forgetMemories(which, which === "workspace" ? where.workspace : undefined);
      setEntries([]);
      setClearing("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="mb-3 rounded-md border border-border bg-muted/20 p-2.5">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p class="text-muted-foreground">{t("plugin.memory.title")}</p>
        <div class="min-w-0 max-w-full">
          <Show
            when={options().length > SCOPES_ON_A_ROW}
            fallback={
              <MiniTabs
                value={scope()}
                options={options().map((option) => ({ ...option, title: option.detail }))}
                onChange={selectScope}
                label={t("plugin.memory.scope.label")}
                class="max-w-full flex-wrap"
              />
            }
          >
            <ScopeMenu value={scope()} options={options()} onChange={selectScope} />
          </Show>
        </div>
      </div>

      {/* A disabled plugin answers no route. Saying so is better than a list
          that fails to load, and better than silence: the reader has to know
          that the memories are still there and still theirs. */}
      <Show when={props.disabled}>
        <p class="mt-2 text-2xs leading-4 text-muted-foreground">{t("plugin.memory.disabled")}</p>
        <Show when={props.onEnable}>
          <Button
            type="button"
            size="xs"
            variant="outline"
            class="mt-2"
            onClick={() => props.onEnable?.()}
          >
            {t("plugin.memory.enableAgain")}
          </Button>
        </Show>
      </Show>
      <Show when={!props.disabled && entries().length > 0} fallback={
        <Show when={!props.disabled}>
          <p class="mt-2 text-2xs leading-4 text-muted-foreground">{t("plugin.memory.empty")}</p>
        </Show>
      }>
        <ul class="mt-2 space-y-1">
          <For each={entries()}>
            {(entry) => (
              <li class="flex items-start gap-2 rounded-md bg-background/60 px-2 py-1.5">
                <Switch
                  checked={entry.enabled}
                  disabled={busy() === entry.id}
                  aria-label={t("plugin.memory.enabled")}
                  onChange={(next) => void toggle(entry, next)}
                />
                <Show
                  when={editing() === entry.id}
                  fallback={
                    <p
                      class={`min-w-0 flex-1 text-xs leading-5 ${
                        entry.enabled ? "text-foreground/90" : "text-muted-foreground line-through"
                      }`}
                    >
                      {entry.text}
                      <Show when={entry.key}>
                        <span class="ml-1 font-mono text-2xs text-muted-foreground">{entry.key}</span>
                      </Show>
                    </p>
                  }
                >
                  <TextFieldInput
                    value={draft()}
                    aria-label={t("plugin.memory.edit")}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                  />
                </Show>
                <div class="flex shrink-0 items-center gap-1">
                  <Show
                    when={editing() === entry.id}
                    fallback={
                      <Button
                        type="button"
                        size="xs"
                        variant="quiet"
                        onClick={() => startEdit(entry)}
                      >
                        {t("plugin.memory.edit")}
                      </Button>
                    }
                  >
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy() === entry.id || !draft().trim()}
                      onClick={() => void save(entry)}
                    >
                      {t("plugin.memory.save")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="quiet"
                      onClick={() => {
                        setEditing("");
                        setDraft("");
                      }}
                    >
                      {t("plugin.memory.cancel")}
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    size="xs"
                    variant="quiet"
                    aria-label={t("plugin.memory.forget")}
                    onClick={() => setForgetting(entry)}
                  >
                    {t("plugin.memory.forget")}
                  </Button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={!props.disabled}>
        <Show when={adding()}>
          <div class="mt-2 flex items-center gap-2">
            <TextFieldInput
              value={newText()}
              placeholder={t("plugin.memory.placeholder")}
              aria-label={t("plugin.memory.add")}
              onInput={(event) => setNewText(event.currentTarget.value)}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy() === "add" || !newText().trim()}
              onClick={() => void add()}
            >
              {t("plugin.memory.save")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="quiet"
              onClick={() => {
                setAdding(false);
                setNewText("");
              }}
            >
              {t("plugin.memory.cancel")}
            </Button>
          </div>
        </Show>

        <Show when={!adding()}>
          <Button
            type="button"
            size="xs"
            variant="quiet"
            class="mt-2"
            onClick={() => setAdding(true)}
          >
            {t("plugin.memory.add")}
          </Button>
        </Show>
      </Show>

      {/* Forgetting everything is not the same as disabling the plugin, and it
          is not the same as forgetting one entry. It gets its own button, and
          its own confirmation, because it cannot be undone. */}
      <Show when={!props.disabled && entries().length > 0}>
        <Button
          type="button"
          size="xs"
          variant="quiet"
          class="mt-2"
          disabled={busy() === "clear"}
          onClick={() => setClearing(scope() === GLOBAL ? GLOBAL : "workspace")}
        >
          {t("plugin.memory.forgetAll")}
        </Button>
      </Show>

      <Show when={error()}>
        <p class="mt-2 break-words text-2xs text-destructive" role="alert">{error()}</p>
      </Show>

      <ConfirmDialog
        open={forgetting() !== undefined}
        title={t("plugin.memory.forgetTitle")}
        description={forgetting()?.text ?? ""}
        confirmLabel={t("plugin.memory.forget")}
        cancelLabel={t("plugin.memory.cancel")}
        pending={busy() === forgetting()?.id}
        onConfirm={() => {
          const entry = forgetting();
          if (entry) void forget(entry);
        }}
        onCancel={() => setForgetting(undefined)}
      />

      <ConfirmDialog
        open={clearing() !== ""}
        title={t("plugin.memory.forgetAllTitle")}
        description={t(
          clearing() === "all" ? "plugin.memory.forgetAllAll" : "plugin.memory.forgetAllScope",
        )}
        confirmLabel={t("plugin.memory.forgetAll")}
        cancelLabel={t("plugin.memory.cancel")}
        pending={busy() === "clear"}
        onConfirm={() => void clear(clearing())}
        onCancel={() => setClearing("")}
      />
    </div>
  );
}

function ScopeMenu(props: {
  value: string;
  options: { id: string; label: string; detail?: string }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const current = () => props.options.find((option) => option.id === props.value) ?? props.options[0];
  const projects = () => props.options.slice(1);
  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} gutter={6}>
      <Tip label={current()?.detail ?? ""} disabled={open() || !current()?.detail}>
        <DropdownMenuTrigger
          class="flex h-7 max-w-full items-center gap-1 rounded-md px-1.5 text-xs text-foreground hover:bg-secondary"
          aria-label={t("plugin.memory.scope.label")}
        >
          <span class="truncate">{current()?.label}</span>
          <svg
            viewBox="0 0 12 12"
            class="size-3 shrink-0 opacity-60"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 4.75 6 7.75l3-3" />
          </svg>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent class="max-h-80 w-72 overflow-y-auto">
        <ScopeRow
          option={props.options[0]!}
          selected={props.value === props.options[0]?.id}
          onSelect={() => props.onChange(props.options[0]!.id)}
        />
        <Show when={projects().length > 0}>
          <DropdownMenuSeparator />
        </Show>
        <For each={projects()}>
          {(option) => (
            <ScopeRow
              option={option}
              selected={props.value === option.id}
              onSelect={() => props.onChange(option.id)}
            />
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScopeRow(props: {
  option: { id: string; label: string; detail?: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={props.onSelect} class="items-start justify-between gap-3">
      <span class="min-w-0">
        <span class={`block truncate text-xs ${props.selected ? "text-foreground" : ""}`}>{props.option.label}</span>
        <Show when={props.option.detail}>
          <span class="block truncate text-2xs text-muted-foreground" title={props.option.detail}>
            {props.option.detail}
          </span>
        </Show>
      </span>
      <Show when={props.selected}>
        <svg
          viewBox="0 0 12 12"
          class="mt-0.5 size-3 shrink-0 text-foreground"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M2.5 6.2 5 8.6l4.5-5" />
        </svg>
      </Show>
    </DropdownMenuItem>
  );
}
