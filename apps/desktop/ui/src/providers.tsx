import { createResource, createSignal, For, Show } from "solid-js";
import { getJson, listProviders, removeProviderKey, saveProviderKey, type ApiProvider, type Connection } from "./api";
import { t } from "./i18n";

function ProviderList(props: { connectionId: string }) {
  const [rows, { refetch }] = createResource(() => listProviders(props.connectionId));
  const [query, setQuery] = createSignal("");
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");

  const visible = (): ApiProvider[] => {
    const needle = query().trim().toLowerCase();
    const all = rows()?.providers ?? [];
    if (!needle) return all;
    return all.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle));
  };

  const save = async (id: string) => {
    const key = drafts()[id]?.trim() ?? "";
    if (!key || busy()) return;
    setBusy(id);
    setError("");
    try {
      await saveProviderKey(props.connectionId, id, key);
      setDrafts((prev) => ({ ...prev, [id]: "" }));
      refetch();
    } catch (e) {
      setError(e instanceof Error && e.message && !e.message.includes(key) ? e.message : t("settings.provider.failed"));
    } finally {
      setBusy("");
    }
  };

  const remove = async (id: string) => {
    if (busy()) return;
    setBusy(id);
    setError("");
    try {
      await removeProviderKey(props.connectionId, id);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.provider.failed"));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="mt-3">
      <Show when={rows.loading}>
        <p class="text-sm text-muted-foreground">{t("search.searching")}</p>
      </Show>
      <Show when={rows.error}>
        <p class="mt-3 text-sm text-destructive">{t("settings.provider.failed")}</p>
      </Show>
      <Show when={!rows.loading && !rows.error && (rows()?.providers.length ?? 0) === 0}>
        <p class="text-sm text-muted-foreground">{t("settings.provider.empty")}</p>
      </Show>
      <Show when={(rows()?.providers.length ?? 0) > 0}>
        <input
          class="h-8 w-full rounded-md border border-border bg-secondary/40 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t("settings.provider.filter")}
          aria-label={t("settings.provider.filter")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <ul class="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto">
          <For each={visible()}>
            {(row) => (
              <li class="rounded-lg border border-border px-3 py-2.5">
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
                  <Show when={row.connected}>
                    <span class="shrink-0 text-2xs text-muted-foreground">{t("settings.provider.connected")}</span>
                  </Show>
                </div>
                <Show when={row.name !== row.id}>
                  <p class="truncate font-mono text-2xs text-muted-foreground">{row.id}</p>
                </Show>
                <form
                  class="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(row.id);
                  }}
                >
                  <input
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    class="h-8 min-w-0 flex-1 rounded-md border border-border bg-secondary/40 px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
                    aria-label={`${row.name} ${t("settings.provider.key")}`}
                    placeholder={t("settings.provider.key")}
                    value={drafts()[row.id] ?? ""}
                    onInput={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.currentTarget.value }))}
                  />
                  <button
                    type="submit"
                    class="shrink-0 rounded-md border border-border px-2.5 text-xs hover:bg-secondary disabled:opacity-40"
                    disabled={busy() === row.id || !(drafts()[row.id] ?? "").trim()}
                  >
                    {t("settings.provider.save")}
                  </button>
                  <Show when={row.connected}>
                    <button
                      type="button"
                      class="shrink-0 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                      disabled={busy() === row.id}
                      onClick={() => void remove(row.id)}
                    >
                      {t("settings.provider.remove")}
                    </button>
                  </Show>
                </form>
              </li>
            )}
          </For>
        </ul>
        <Show when={error()}>
          <p class="mt-2 text-sm text-destructive">{error()}</p>
        </Show>
      </Show>
    </div>
  );
}

export function ProviderSettings() {
  const [conns] = createResource(() => getJson<{ connections: Connection[] }>("/connections"));
  const opencode = () => (conns()?.connections ?? []).filter((conn) => conn.backend === "opencode");

  return (
    <section class="mt-8">
      <h2 class="text-sm font-medium">{t("settings.provider.title")}</h2>
      <p class="mt-1 text-sm leading-5 text-muted-foreground">{t("settings.provider.hint")}</p>
      <Show when={!conns.loading && opencode().length === 0}>
        <p class="mt-3 text-sm text-muted-foreground">{t("settings.provider.offline")}</p>
      </Show>
      <For each={opencode()}>{(conn) => <ProviderList connectionId={conn.id} />}</For>
    </section>
  );
}
