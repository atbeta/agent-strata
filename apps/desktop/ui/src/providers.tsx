import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import {
  beginProviderLogin,
  finishProviderLogin,
  getJson,
  listProviders,
  removeProviderKey,
  saveProviderKey,
  type ApiProvider,
  type Connection,
  type OAuthStart,
  type ProviderMethod,
  type ProviderPrompt,
} from "./api";
import { t } from "./i18n";

function promptShown(prompt: ProviderPrompt, inputs: Record<string, string>): boolean {
  if (!prompt.when) return true;
  const value = inputs[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
}

function ProviderList(props: { connectionId: string }) {
  const [rows, { refetch }] = createResource(() => listProviders(props.connectionId));
  const [query, setQuery] = createSignal("");
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  const [login, setLogin] = createSignal<{ id: string; method: ProviderMethod; inputs: Record<string, string> }>();
  const [pending, setPending] = createSignal<{ id: string; index: number; start: OAuthStart }>();
  const [code, setCode] = createSignal("");
  let wait: AbortController | undefined;
  onCleanup(() => wait?.abort());

  const visible = (): ApiProvider[] => {
    const needle = query().trim().toLowerCase();
    const all = rows()?.providers ?? [];
    if (!needle) return all;
    return all.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle));
  };

  const fail = (e: unknown, secret = "") => {
    const message = e instanceof Error ? e.message : "";
    if (e instanceof DOMException && e.name === "AbortError") return;
    setError(message && !secret ? message : message && !message.includes(secret) ? message : t("settings.provider.failed"));
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
      fail(e, key);
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
      fail(e);
    } finally {
      setBusy("");
    }
  };

  const cancelLogin = () => {
    wait?.abort();
    wait = undefined;
    setPending(undefined);
    setLogin(undefined);
    setCode("");
  };

  const authorize = async (id: string, method: ProviderMethod, inputs?: Record<string, string>) => {
    if (busy()) return;
    setBusy(id);
    setError("");
    try {
      const start = await beginProviderLogin(props.connectionId, id, method.index, inputs);
      setLogin(undefined);
      setPending({ id, index: method.index, start });
      setCode("");
      if (start.method !== "auto") return;
      wait?.abort();
      wait = new AbortController();
      await finishProviderLogin(props.connectionId, id, method.index, undefined, wait.signal);
      setPending(undefined);
      refetch();
    } catch (e) {
      setPending(undefined);
      fail(e);
    } finally {
      setBusy("");
    }
  };

  const submitCode = async () => {
    const current = pending();
    const value = code().trim();
    if (!current || current.start.method !== "code" || !value || busy()) return;
    setBusy(current.id);
    setError("");
    try {
      await finishProviderLogin(props.connectionId, current.id, current.index, value);
      setCode("");
      setPending(undefined);
      refetch();
    } catch (e) {
      fail(e, value);
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
            {(row) => {
              const apiMethod = () => row.methods.find((method) => method.type === "api");
              const oauthMethods = () => row.methods.filter((method) => method.type === "oauth");
              const asking = () => (login()?.id === row.id ? login() : undefined);
              const flow = () => (pending()?.id === row.id ? pending() : undefined);
              return (
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
                  <Show when={apiMethod() && !flow()}>
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
                  </Show>
                  <Show when={oauthMethods().length > 0 && !flow() && !asking()}>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <For each={oauthMethods()}>
                        {(method) => (
                          <button
                            type="button"
                            class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary disabled:opacity-40"
                            disabled={busy() === row.id}
                            onClick={() => {
                              if (method.prompts?.length) {
                                setLogin({ id: row.id, method, inputs: {} });
                                return;
                              }
                              void authorize(row.id, method);
                            }}
                          >
                            {method.label}
                          </button>
                        )}
                      </For>
                      <Show when={row.connected && !apiMethod()}>
                        <button
                          type="button"
                          class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                          disabled={busy() === row.id}
                          onClick={() => void remove(row.id)}
                        >
                          {t("settings.provider.remove")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                  <Show when={asking()}>
                    {(ask) => (
                      <form
                        class="mt-2 flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void authorize(row.id, ask().method, ask().inputs);
                        }}
                      >
                        <For each={ask().method.prompts ?? []}>
                          {(prompt) => (
                            <Show when={promptShown(prompt, ask().inputs)}>
                              <label class="block text-xs text-muted-foreground">
                                {prompt.message}
                                <Show
                                  when={prompt.type === "select"}
                                  fallback={
                                    <input
                                      class="mt-1 h-8 w-full rounded-md border border-border bg-secondary/40 px-3 text-sm text-foreground outline-none"
                                      placeholder={prompt.placeholder ?? ""}
                                      value={ask().inputs[prompt.key] ?? ""}
                                      onInput={(e) =>
                                        setLogin({
                                          id: row.id,
                                          method: ask().method,
                                          inputs: { ...ask().inputs, [prompt.key]: e.currentTarget.value },
                                        })
                                      }
                                    />
                                  }
                                >
                                  <select
                                    class="mt-1 h-8 w-full rounded-md border border-border bg-secondary/40 px-2 text-sm text-foreground"
                                    value={ask().inputs[prompt.key] ?? ""}
                                    onChange={(e) =>
                                      setLogin({
                                        id: row.id,
                                        method: ask().method,
                                        inputs: { ...ask().inputs, [prompt.key]: e.currentTarget.value },
                                      })
                                    }
                                  >
                                    <option value="" />
                                    <For each={prompt.options ?? []}>
                                      {(option) => <option value={option.value}>{option.label}</option>}
                                    </For>
                                  </select>
                                </Show>
                              </label>
                            </Show>
                          )}
                        </For>
                        <div class="flex gap-2">
                          <button type="submit" class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary">
                            {t("settings.provider.confirm")}
                          </button>
                          <button
                            type="button"
                            class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary"
                            onClick={() => setLogin(undefined)}
                          >
                            {t("settings.provider.cancel")}
                          </button>
                        </div>
                      </form>
                    )}
                  </Show>
                  <Show when={flow()}>
                    {(flow) => (
                      <div class="mt-2">
                        <p class="text-sm whitespace-pre-wrap text-foreground">{flow().start.instructions}</p>
                        <a
                          class="mt-2 inline-block text-sm text-foreground underline"
                          href={flow().start.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("settings.provider.open")}
                        </a>
                        <Show
                          when={flow().start.method === "code"}
                          fallback={<p class="mt-2 text-xs text-muted-foreground">{t("settings.provider.waiting")}</p>}
                        >
                          <form
                            class="mt-2 flex gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void submitCode();
                            }}
                          >
                            <input
                              class="h-8 min-w-0 flex-1 rounded-md border border-border bg-secondary/40 px-3 text-sm text-foreground outline-none"
                              aria-label={t("settings.provider.code")}
                              placeholder={t("settings.provider.code")}
                              autocomplete="off"
                              spellcheck={false}
                              value={code()}
                              onInput={(e) => setCode(e.currentTarget.value)}
                            />
                            <button
                              type="submit"
                              class="shrink-0 rounded-md border border-border px-2.5 text-xs hover:bg-secondary disabled:opacity-40"
                              disabled={!code().trim() || busy() === row.id}
                            >
                              {t("settings.provider.confirm")}
                            </button>
                          </form>
                        </Show>
                        <button
                          type="button"
                          class="mt-2 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary"
                          onClick={cancelLogin}
                        >
                          {t("settings.provider.cancel")}
                        </button>
                      </div>
                    )}
                  </Show>
                </li>
              );
            }}
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
