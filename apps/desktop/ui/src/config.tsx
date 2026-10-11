import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { getJson, readConfig, saveConfig, type Connection } from "./api";
import { t } from "./i18n";

function explain(message: string, draft: string): string {
  if (message === "invalid config") return t("settings.config.invalid");
  if (message === "config cannot remove fields") return t("settings.config.remove");
  if (!message || message === "config update failed" || message === "directory required") return t("settings.config.failed");
  const sample = draft.trim().slice(0, 80);
  if (sample.length >= 12 && message.includes(sample)) return t("settings.config.failed");
  return message;
}

function ConfigEditor(props: { connection: Connection; workspaces: { directory: string; name?: string }[] }) {
  const dirs = () => {
    const list = props.workspaces.filter((workspace) => workspace.directory);
    const home = props.connection.directory;
    if (home && !list.some((workspace) => workspace.directory === home)) list.unshift({ directory: home });
    return list;
  };
  const [directory, setDirectory] = createSignal(props.connection.directory ?? "");
  const [doc, { refetch }] = createResource(directory, (dir) => (dir ? readConfig(props.connection.id, dir) : undefined));
  const [text, setText] = createSignal("");
  const [loadedFor, setLoadedFor] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    const first = dirs()[0]?.directory;
    if (!directory() && first) setDirectory(first);
  });

  createEffect(() => {
    const dir = directory();
    const loaded = doc();
    if (!dir || !loaded || doc.loading || loadedFor() === dir) return;
    setText(JSON.stringify(loaded.config, null, 2));
    setLoadedFor(dir);
    setNotice("");
    setFailed(false);
  });

  createEffect(() => {
    const err = doc.error;
    if (!err || doc.loading) return;
    setFailed(true);
    setNotice(explain(err instanceof Error ? err.message : "", text()));
  });

  const save = async () => {
    const dir = directory();
    const draft = text();
    if (!dir || !draft.trim() || busy()) return;
    setBusy(true);
    setNotice("");
    setFailed(false);
    try {
      await saveConfig(props.connection.id, dir, draft);
      setNotice(t("settings.config.saved"));
      setLoadedFor("");
      refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setNotice(explain(message, draft));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mt-4">
      <Show when={dirs().length > 0}>
        <label class="block text-xs text-muted-foreground">
          {t("settings.config.directory")}
          <select
            class="mt-1 h-8 w-full rounded-md border border-border bg-secondary/40 px-2 text-sm text-foreground"
            value={directory()}
            onChange={(e) => {
              setLoadedFor("");
              setDirectory(e.currentTarget.value);
            }}
          >
            <For each={dirs()}>
              {(workspace) => (
                <option value={workspace.directory}>{workspace.name ? `${workspace.name} · ${workspace.directory}` : workspace.directory}</option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <textarea
        class="mt-3 min-h-64 w-full rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs text-foreground outline-none"
        spellcheck={false}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div class="mt-2 flex items-center gap-3">
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary disabled:opacity-40"
          disabled={busy() || !text().trim() || !directory()}
          onClick={() => void save()}
        >
          {t(busy() ? "settings.config.saving" : "settings.config.save")}
        </button>
        <Show when={notice()}>
          <p class={`text-xs ${failed() ? "text-destructive" : "text-muted-foreground"}`}>{notice()}</p>
        </Show>
      </div>
    </div>
  );
}

export function ConfigSettings() {
  const [conns] = createResource(() => getJson<{ connections: Connection[] }>("/connections"));
  const [spaces] = createResource(() => getJson<{ workspaces: { directory: string; name?: string }[] }>("/workspaces"));
  const opencode = () => (conns()?.connections ?? []).filter((conn) => conn.backend === "opencode");

  return (
    <section class="mt-8 border-t border-border pt-6">
      <h2 class="text-sm font-medium">{t("settings.config.title")}</h2>
      <p class="mt-1 text-sm leading-5 text-muted-foreground">{t("settings.config.hint")}</p>
      <Show when={!conns.loading && opencode().length === 0}>
        <p class="mt-3 text-sm text-muted-foreground">{t("settings.config.offline")}</p>
      </Show>
      <For each={opencode()}>
        {(conn) => <ConfigEditor connection={conn} workspaces={spaces()?.workspaces ?? []} />}
      </For>
    </section>
  );
}
