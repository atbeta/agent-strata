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
import { Icon } from "./icons";
import { Group } from "./settings-blocks";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Providers used to be twenty full cards, each with its own password box and
 * two buttons, all open at once. Nothing could be told apart and every new way
 * of signing in made the cards taller.
 *
 * This is the list every other tool converged on instead: one line per
 * provider, the detail behind a disclosure, and the shape of that detail
 * decided by the backend's own `methods` array. A provider that grows a new
 * kind of credential gains one more option in the list — no branch here.
 */

/** A prompt is skipped when the field it depends on already answers it. */
function promptShown(prompt: ProviderPrompt, inputs: Record<string, string>): boolean {
  if (!prompt.when) return true;
  const value = inputs[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
}

/** A key is what most people reach for; OAuth is the fallback worth a click. */
function preferredMethod(row: ApiProvider): number | undefined {
  return (row.methods.find((method) => method.type === "api") ?? row.methods[0])?.index;
}

/** Connected or not, said by a dot and a word rather than by colour alone. */
function Dot(props: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      class={`size-1.5 shrink-0 rounded-full ${
        props.on ? "bg-status-active" : "border border-muted-foreground/40"
      }`}
    />
  );
}

function ProviderDetail(props: {
  row: ApiProvider;
  method?: ProviderMethod;
  draft: string;
  inputs: Record<string, string>;
  busy: boolean;
  error: string;
  flow?: { start: OAuthStart };
  code: string;
  onPick: (index: number) => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onInput: (key: string, value: string) => void;
  onAuthorize: (inputs: Record<string, string>) => void;
  onCode: (value: string) => void;
  onSubmitCode: () => void;
  onCancelFlow: () => void;
}) {
  const method = () => props.method;
  const prompts = () => method()?.prompts ?? [];

  const keyForm = (
    <form
      class="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <input
        type="password"
        autocomplete="off"
        spellcheck={false}
        class="h-8 min-w-0 flex-1 rounded-md border border-border bg-secondary/40 px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        aria-label={`${props.row.name} ${t("settings.provider.key")}`}
        placeholder={
          props.row.connected ? t("settings.provider.keyReplace") : t("settings.provider.key")
        }
        value={props.draft}
        onInput={(event) => props.onDraft(event.currentTarget.value)}
      />
      <Button type="submit" variant="outline" size="sm" disabled={props.busy || !props.draft.trim()}>
        {props.row.connected ? t("settings.provider.replace") : t("settings.provider.save")}
      </Button>
    </form>
  );

  return (
    <div class="mt-1 ml-4 rounded-lg border border-border p-2">
      <Show when={props.error}>
        <p class="mb-2 text-2xs text-destructive">{props.error}</p>
      </Show>

      {/* The sign-in flow takes the whole panel: it is a sequence of steps, not
          a form you keep editing beside a list of alternatives. */}
      <Show
        when={!props.flow}
        fallback={
          <div>
            <p class="text-sm whitespace-pre-wrap">{props.flow?.start.instructions}</p>
            <a
              class="mt-1.5 inline-flex items-center gap-1.5 text-sm text-foreground underline"
              href={props.flow?.start.url}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="globe" class="size-3.5" />
              {t("settings.provider.open")}
            </a>
            <Show
              when={props.flow?.start.method === "code"}
              fallback={
                <p class="mt-1.5 text-2xs text-muted-foreground">{t("settings.provider.waiting")}</p>
              }
            >
              <form
                class="mt-2 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  props.onSubmitCode();
                }}
              >
                <input
                  class="h-8 min-w-0 flex-1 rounded-md border border-border bg-secondary/40 px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
                  aria-label={t("settings.provider.code")}
                  placeholder={t("settings.provider.code")}
                  autocomplete="off"
                  spellcheck={false}
                  value={props.code}
                  onInput={(event) => props.onCode(event.currentTarget.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={props.busy || !props.code.trim()}
                >
                  {t("settings.provider.confirm")}
                </Button>
              </form>
            </Show>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="mt-2 text-muted-foreground"
              onClick={props.onCancelFlow}
            >
              {t("settings.provider.cancel")}
            </Button>
          </div>
        }
      >
        <Show when={props.row.methods.length > 1}>
          <div role="radiogroup" aria-label={t("settings.provider.method")}>
            <For each={props.row.methods}>
              {(option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={option.index === method()?.index}
                  class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    option.index === method()?.index
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  }`}
                  onClick={() => props.onPick(option.index)}
                >
                  <span class="w-3 shrink-0">
                    <Show when={option.index === method()?.index}>
                      <Icon name="check" class="size-3" />
                    </Show>
                  </span>
                  <span class="min-w-0 flex-1 truncate text-sm">{option.label}</span>
                  <Show when={option.type === "api" && props.row.connected}>
                    <span class="shrink-0 text-2xs text-muted-foreground">
                      {t("settings.provider.connected")}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={method()} keyed>
          {(current) => (
            <div class="mt-2">
              <Show when={current.type === "api"} fallback={
                <Show
                  when={prompts().length > 0}
                  fallback={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={props.busy}
                      onClick={() => props.onAuthorize({})}
                    >
                      <Icon name="plug" class="size-3.5" />
                      {t("settings.provider.login")}
                    </Button>
                  }
                >
                  <form
                    class="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      props.onAuthorize(props.inputs);
                    }}
                  >
                    <For each={prompts()}>
                      {(prompt) => (
                        <Show when={promptShown(prompt, props.inputs)}>
                          <label class="block text-xs text-muted-foreground">
                            {prompt.message}
                            <Show
                              when={prompt.type === "select"}
                              fallback={
                                <input
                                  class="mt-1 h-8 w-full rounded-md border border-border bg-secondary/40 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
                                  placeholder={prompt.placeholder ?? ""}
                                  value={props.inputs[prompt.key] ?? ""}
                                  onInput={(event) =>
                                    props.onInput(prompt.key, event.currentTarget.value)
                                  }
                                />
                              }
                            >
                              <Picker
                                class="mt-1 h-8 w-full max-w-none justify-between gap-2 border border-border px-2.5 text-sm text-foreground hover:bg-secondary/40"
                                label={prompt.message}
                                placeholder={prompt.placeholder}
                                emptyOption={prompt.placeholder}
                                allowEmpty
                                value={props.inputs[prompt.key] ?? ""}
                                options={(prompt.options ?? []).map((item) => ({
                                  value: item.value,
                                  label: item.label,
                                }))}
                                onChange={(value) => props.onInput(prompt.key, value)}
                              />
                            </Show>
                          </label>
                        </Show>
                      )}
                    </For>
                    <div>
                      <Button type="submit" variant="outline" size="sm" disabled={props.busy}>
                        {t("settings.provider.confirm")}
                      </Button>
                    </div>
                  </form>
                </Show>
              }>
                {keyForm}
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

function ProviderRow(props: {
  row: ApiProvider;
  open: boolean;
  busy: boolean;
  draft: string;
  inputs: Record<string, string>;
  error: string;
  method?: ProviderMethod;
  flow?: { start: OAuthStart };
  code: string;
  onToggle: () => void;
  onRemove: () => void;
  onPick: (index: number) => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onInput: (key: string, value: string) => void;
  onAuthorize: (inputs: Record<string, string>) => void;
  onCode: (value: string) => void;
  onSubmitCode: () => void;
  onCancelFlow: () => void;
}) {
  const panel = () => `provider-panel-${props.row.id}`;

  return (
    <li class="py-0.5">
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/60"
          aria-expanded={props.row.methods.length > 0 ? props.open : undefined}
          aria-controls={props.row.methods.length > 0 ? panel() : undefined}
          onClick={() => {
            if (props.row.methods.length > 0) props.onToggle();
          }}
        >
          <Dot on={props.row.connected} />
          <span class="shrink-0 text-sm text-foreground">{props.row.name}</span>
          <Show when={props.row.name !== props.row.id}>
            <span class="truncate font-mono text-2xs text-muted-foreground">{props.row.id}</span>
          </Show>
          <span class="ml-auto flex shrink-0 items-center gap-2">
            <Show when={props.row.connected}>
              <span class="text-2xs text-muted-foreground">{t("settings.provider.connected")}</span>
            </Show>
            <Show when={props.row.methods.length > 0}>
              <Icon
                name="chevron"
                class={`size-3 text-muted-foreground transition-transform ${
                  props.open ? "" : "-rotate-90"
                }`}
              />
            </Show>
          </span>
        </button>

        {/* Disconnecting is destructive and rare, so it waits to be asked for
            instead of sitting on every connected row all day. */}
        <Show when={props.row.connected}>
          <DropdownMenu>
            <DropdownMenuTrigger
              class="size-6 shrink-0 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              aria-label={t("settings.provider.actions")}
            >
              <Icon name="more" class="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                class="text-destructive data-[highlighted]:text-destructive"
                onSelect={props.onRemove}
              >
                {t("settings.provider.disconnect")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
      </div>

      <Show when={props.open}>
        <div id={panel()}>
          <ProviderDetail
            row={props.row}
            method={props.method}
            draft={props.draft}
            inputs={props.inputs}
            busy={props.busy}
            error={props.error}
            flow={props.flow}
            code={props.code}
            onPick={props.onPick}
            onDraft={props.onDraft}
            onSave={props.onSave}
            onInput={props.onInput}
            onAuthorize={props.onAuthorize}
            onCode={props.onCode}
            onSubmitCode={props.onSubmitCode}
            onCancelFlow={props.onCancelFlow}
          />
        </div>
      </Show>
    </li>
  );
}

function ProviderList(props: { connectionId: string }) {
  const [rows, { refetch }] = createResource(() => listProviders(props.connectionId));
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal("");
  const [picks, setPicks] = createSignal<Record<string, number>>({});
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [inputs, setInputs] = createSignal<Record<string, Record<string, string>>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal("");
  const [flow, setFlow] = createSignal<{ id: string; index: number; start: OAuthStart }>();
  const [code, setCode] = createSignal("");
  let wait: AbortController | undefined;
  onCleanup(() => wait?.abort());

  const all = () => rows()?.providers ?? [];
  const visible = (): ApiProvider[] => {
    const needle = query().trim().toLowerCase();
    if (!needle) return all();
    return all().filter(
      (row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle),
    );
  };
  const linked = () => visible().filter((row) => row.connected);
  const rest = () => visible().filter((row) => !row.connected);

  const pick = (row: ApiProvider): ProviderMethod | undefined => {
    const chosen = picks()[row.id];
    const index = chosen === undefined ? preferredMethod(row) : chosen;
    return row.methods.find((method) => method.index === index) ?? row.methods[0];
  };

  const fail = (id: string, e: unknown, secret = "") => {
    if (e instanceof DOMException && e.name === "AbortError") return;
    const message = e instanceof Error ? e.message : "";
    const text =
      message && !secret
        ? message
        : message && !message.includes(secret)
          ? message
          : t("settings.provider.failed");
    setErrors((prev) => ({ ...prev, [id]: text }));
    setOpen(id);
  };

  const clearError = (id: string) => setErrors((prev) => ({ ...prev, [id]: "" }));

  const save = async (row: ApiProvider) => {
    const key = drafts()[row.id]?.trim() ?? "";
    if (!key || busy()) return;
    setBusy(row.id);
    clearError(row.id);
    try {
      await saveProviderKey(props.connectionId, row.id, key);
      setDrafts((prev) => ({ ...prev, [row.id]: "" }));
      refetch();
    } catch (e) {
      fail(row.id, e, key);
    } finally {
      setBusy("");
    }
  };

  const remove = async (row: ApiProvider) => {
    if (busy()) return;
    setBusy(row.id);
    clearError(row.id);
    try {
      await removeProviderKey(props.connectionId, row.id);
      setOpen("");
      refetch();
    } catch (e) {
      fail(row.id, e);
    } finally {
      setBusy("");
    }
  };

  const cancelFlow = () => {
    wait?.abort();
    wait = undefined;
    setFlow(undefined);
    setCode("");
  };

  const authorize = async (row: ApiProvider, values: Record<string, string>) => {
    const method = pick(row);
    if (!method || busy()) return;
    setBusy(row.id);
    clearError(row.id);
    try {
      const start = await beginProviderLogin(props.connectionId, row.id, method.index, values);
      setFlow({ id: row.id, index: method.index, start });
      setCode("");
      if (start.method !== "auto") return;
      wait?.abort();
      wait = new AbortController();
      await finishProviderLogin(props.connectionId, row.id, method.index, undefined, wait.signal);
      setFlow(undefined);
      refetch();
    } catch (e) {
      setFlow(undefined);
      fail(row.id, e);
    } finally {
      setBusy("");
    }
  };

  const submitCode = async () => {
    const current = flow();
    const value = code().trim();
    if (!current || current.start.method !== "code" || !value || busy()) return;
    setBusy(current.id);
    clearError(current.id);
    try {
      await finishProviderLogin(props.connectionId, current.id, current.index, value);
      setCode("");
      setFlow(undefined);
      refetch();
    } catch (e) {
      fail(current.id, e, value);
    } finally {
      setBusy("");
    }
  };

  const group = (label: string, list: ApiProvider[]) => (
    <Show when={list.length > 0}>
      <div class="mt-4">
        <div class="mb-1 flex items-baseline gap-2 text-2xs text-muted-foreground">
          <span>{label}</span>
          <span class="font-mono">{list.length}</span>
        </div>
        <ul class="divide-y divide-border">
          <For each={list}>
            {(row) => (
              <ProviderRow
                row={row}
                open={open() === row.id}
                busy={busy() === row.id}
                draft={drafts()[row.id] ?? ""}
                inputs={inputs()[row.id] ?? {}}
                error={errors()[row.id] ?? ""}
                method={pick(row)}
                flow={flow()?.id === row.id ? { start: flow()!.start } : undefined}
                code={code()}
                onToggle={() => setOpen(open() === row.id ? "" : row.id)}
                onRemove={() => void remove(row)}
                onPick={(index) => setPicks((prev) => ({ ...prev, [row.id]: index }))}
                onDraft={(value) => setDrafts((prev) => ({ ...prev, [row.id]: value }))}
                onSave={() => void save(row)}
                onInput={(key, value) =>
                  setInputs((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] ?? {}), [key]: value } }))
                }
                onAuthorize={(values) => void authorize(row, values)}
                onCode={setCode}
                onSubmitCode={() => void submitCode()}
                onCancelFlow={cancelFlow}
              />
            )}
          </For>
        </ul>
      </div>
    </Show>
  );

  return (
    <div class="mt-3">
      <Show when={rows.loading}>
        <p class="text-sm text-muted-foreground">{t("search.searching")}</p>
      </Show>
      <Show when={rows.error}>
        <p class="text-sm text-destructive">{t("settings.provider.failed")}</p>
      </Show>
      <Show when={!rows.loading && !rows.error && all().length === 0}>
        <p class="text-sm text-muted-foreground">{t("settings.provider.empty")}</p>
      </Show>

      {/* Filtering earns its line only once the list is long enough to need it;
          the two or three providers of a fresh install should not carry a
          search box for a list you can already read. */}
      <Show when={all().length > 6}>
        <input
          class="h-8 w-full rounded-md border border-border bg-secondary/40 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          type="search"
          placeholder={t("settings.provider.filter")}
          aria-label={t("settings.provider.filter")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </Show>

      {group(t("settings.provider.linked"), linked())}
      {group(t("settings.provider.available"), rest())}

      <Show when={!rows.loading && !rows.error && all().length > 0 && visible().length === 0}>
        <p class="mt-4 text-sm text-muted-foreground">{t("settings.provider.noMatch")}</p>
      </Show>
    </div>
  );
}

export function ProviderSettings() {
  const [conns] = createResource(() => getJson<{ connections: Connection[] }>("/connections"));
  const opencode = () => (conns()?.connections ?? []).filter((conn) => conn.backend === "opencode");

  return (
    <Group label={t("settings.provider.title")}>
      <p class="text-2xs leading-4 text-muted-foreground">{t("settings.provider.hint")}</p>
      <Show when={!conns.loading && opencode().length === 0}>
        <p class="mt-3 text-sm text-muted-foreground">{t("settings.provider.offline")}</p>
      </Show>
      <For each={opencode()}>{(conn) => <ProviderList connectionId={conn.id} />}</For>
    </Group>
  );
}
