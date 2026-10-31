import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
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
import { Card, Group } from "./settings-blocks";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RowButton } from "@/components/ui/row-button";
import { TextFieldInput } from "@/components/ui/text-field";
import { hiddenProviders, setProviderHidden, showAllProviders } from "./provider-visibility";

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

/**
 * Whether the row opens into something.
 *
 * Not `methods.length`: a vendor with no OAuth flow has no method to choose
 * from, and gating on that hid the API key box for exactly the vendors that
 * only ever wanted a key — the row looked like it had nothing to offer.
 */
function expandable(row: ApiProvider): boolean {
  return row.methods.length > 0 || row.canKey;
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
      <TextFieldInput
        type="password"
        autocomplete="off"
        spellcheck={false}
        size="xs"
        mono
        class="min-w-0 flex-1"
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
                <TextFieldInput
                  size="xs"
                  mono
                  class="min-w-0 flex-1"
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
                <RowButton
                  role="radio"
                  aria-checked={option.index === method()?.index}
                  class={`gap-2 hover:bg-secondary/50 ${
                    option.index === method()?.index ? "bg-secondary text-foreground" : ""
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
                </RowButton>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={method()}
          keyed
          fallback={
            // No sign-in method to pick from, but a key is still the whole
            // point of the row. Showing nothing here was the reason the API-key
            // vendors could be listed but never configured.
            <Show when={props.row.canKey}>
              <div class="mt-2">{keyForm}</div>
            </Show>
          }
        >
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
                                <TextFieldInput
                                  size="sm"
                                  class="mt-1"
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
  /** A removal that landed but the running server cannot show yet. */
  notice?: string;
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
  /** The reader hid this provider from the model picker. */
  hidden: boolean;
  onToggleVisible: () => void;
}) {
  const panel = () => `provider-panel-${props.row.id}`;

  return (
    // The row's px-2 plus RowButton's own px-2 put the name on the card's
    // px-4 line, and py-1 + the button's py-1.5 make the row read py-2.5.
    <li class="px-2 py-1">
      <div class="flex items-center gap-1">
        <RowButton
          class={`min-w-0 flex-1 gap-2.5 ${props.hidden ? "opacity-60" : ""}`}
          aria-expanded={expandable(props.row) ? props.open : undefined}
          aria-controls={expandable(props.row) ? panel() : undefined}
          onClick={() => {
            if (expandable(props.row)) props.onToggle();
          }}
        >
          <Dot on={props.row.connected} />
          <span class="shrink-0 text-sm text-foreground">{props.row.name}</span>
          <Show when={props.row.name !== props.row.id}>
            <span class="truncate font-mono text-2xs text-muted-foreground">{props.row.id}</span>
          </Show>
          <span class="ml-auto flex shrink-0 items-center gap-2">
            <Show when={expandable(props.row)}>
              <Icon
                name="chevron"
                class={`size-3 text-muted-foreground transition-transform ${
                  props.open ? "" : "-rotate-90"
                }`}
              />
            </Show>
          </span>
        </RowButton>

        {/* A display choice, not a credential action: the eye is outside the
            row button because a button cannot nest in one, and the action has
            to stay reachable for an unconnected provider too. */}
        <Button
          type="button"
          size="icon-2xs"
          variant="icon"
          class="shrink-0 text-muted-foreground"
          aria-label={t(
            props.hidden ? "settings.provider.showInPicker" : "settings.provider.hideInPicker",
          )}
          title={t(
            props.hidden ? "settings.provider.showInPicker" : "settings.provider.hideInPicker",
          )}
          onClick={props.onToggleVisible}
        >
          <Icon name={props.hidden ? "eye-off" : "eye"} class="size-3.5" />
        </Button>

        {/* Disconnecting is destructive and rare, so it waits to be asked for
            instead of sitting on every connected row all day.

            `methods` is deliberately not a gate here. An empty list means the
            provider has no sign-in method, not that it has no credential: the
            service synthesises `methods: []` precisely for the API-key entries
            that never appear in OpenCode's auth-method table, and those are
            exactly the credentials this action removes.

            The remaining gap is the other way round: `connected` also covers a
            provider held open by a shared env var or an OpenCode account, where
            there is nothing stored to delete and this becomes a no-op. OpenCode
            does not say which is which, and a row that works but reads 未接入
            is the worse lie. */}
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

      {/* On the row rather than inside the panel: a provider with no sign-in
          method has no panel to open, and those are exactly the ones whose
          removal lands without moving the list. */}
      <Show when={props.notice}>
        {(text) => <p class="px-4 pt-1 text-2xs leading-4 text-muted-foreground">{text()}</p>}
      </Show>

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
  /**
   * A removal that landed but cannot show up in the list yet.
   *
   * OpenCode reads its auth store once and serves that view for the life of the
   * process, so the delete writes `auth.json` and the running server keeps
   * answering `connected`. The list is not stale in this window — it is what the
   * server actually reports — so the row keeps its 已接入 marker and the user
   * would otherwise conclude the button did nothing. Cleared on its own once
   * the provider stops being reported connected, which is what a restart does.
   */
  const [notices, setNotices] = createSignal<Record<string, string>>({});
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
  const clearNotice = (id: string) => setNotices((prev) => ({ ...prev, [id]: "" }));

  // The notice has an ending of its own: once the server stops reporting the
  // provider as connected the row has already moved on, and a note about a
  // restart would outlive the thing it was about.
  createEffect(() => {
    const stillConnected = new Set(all().filter((r) => r.connected).map((r) => r.id));
    if (!Object.keys(notices()).some((id) => !stillConnected.has(id))) return;
    setNotices((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => stillConnected.has(id))),
    );
  });

  const save = async (row: ApiProvider) => {
    const key = drafts()[row.id]?.trim() ?? "";
    if (!key || busy()) return;
    setBusy(row.id);
    clearError(row.id);
    clearNotice(row.id);
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
    clearNotice(row.id);
    try {
      await removeProviderKey(props.connectionId, row.id);
      setOpen("");
      setNotices((prev) => ({ ...prev, [row.id]: t("settings.provider.removed") }));
      refetch();
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
          <span class="tabular-nums text-muted-foreground/60">{list.length}</span>
        </div>
        <Card class="px-0">
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
                notice={notices()[row.id] ?? ""}
                method={pick(row)}
                flow={flow()?.id === row.id ? { start: flow()!.start } : undefined}
                code={code()}
                onToggle={() => setOpen(open() === row.id ? "" : row.id)}
                onRemove={() => void remove(row)}
                onPick={(index) => setPicks((prev) => ({ ...prev, [row.id]: index }))}
                onDraft={(value) => setDrafts((prev) => ({ ...prev, [row.id]: value }))}
                onSave={() => void save(row)}
                onInput={(key, value) =>
                  setInputs((prev) => ({ ...prev, [row.id]: { ...prev[row.id], [key]: value } }))
                }
                onAuthorize={(values) => void authorize(row, values)}
                onCode={setCode}
                onSubmitCode={() => void submitCode()}
                onCancelFlow={cancelFlow}
                hidden={hiddenProviders().has(row.id)}
                onToggleVisible={() => setProviderHidden(row.id, !hiddenProviders().has(row.id))}
              />
            )}
            </For>
          </ul>
        </Card>
      </div>
    </Show>
  );

  return (
    <div class="mt-3">
      {/* Only while there is nothing on screen to keep. A refetch — a
          disconnect just fired, or the window regained focus — used to replace
          the whole list with one line, and that line borrowed the global
          search's "searching" because nothing here searches: the query below
          filters in memory over rows already loaded. */}
      <Show when={rows.loading && all().length === 0}>
        <p class="text-sm text-muted-foreground">{t("settings.provider.loading")}</p>
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
        <TextFieldInput
          size="sm"
          type="search"
          placeholder={t("settings.provider.filter")}
          aria-label={t("settings.provider.filter")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </Show>

      {group(t("settings.provider.linked"), linked())}
      {group(t("settings.provider.available"), rest())}

      <Show when={!rows.error && all().length > 0 && visible().length === 0}>
        <p class="mt-4 text-sm text-muted-foreground">{t("settings.provider.noMatch")}</p>
      </Show>
      <Show when={hiddenProviders().size > 0}>
        <div class="mt-4 flex items-start gap-3">
          <p class="min-w-0 flex-1 text-2xs leading-4 text-muted-foreground">
            {t("settings.provider.hiddenHint")}
          </p>
          <Button
            type="button"
            size="xs"
            variant="quiet"
            class="shrink-0"
            onClick={() => showAllProviders()}
          >
            {t("settings.provider.showAll")}
          </Button>
        </div>
      </Show>
    </div>
  );
}

export function ProviderSettings() {
  const [conns] = createResource(() => getJson<{ connections: Connection[] }>("/connections"));
  const opencode = () => (conns()?.connections ?? []).filter((conn) => conn.backend === "opencode");

  return (
    <Group label={t("settings.provider.title")} hint={t("settings.provider.hint")}>
      <Show when={!conns.loading && opencode().length === 0}>
        <p class="mt-3 text-sm text-muted-foreground">{t("settings.provider.offline")}</p>
      </Show>
      <For each={opencode()}>{(conn) => <ProviderList connectionId={conn.id} />}</For>
    </Group>
  );
}
