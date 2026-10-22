import { createEffect, createSignal, onCleanup, For, Show } from "solid-js";
import {
  addMcp,
  beginMcpLogin,
  connectMcp,
  disconnectMcp,
  finishMcpLogin,
  readMcp,
  type LspServer,
  type McpServerStatus,
} from "./api";
import { t } from "./i18n";
import type { MessageKey } from "./locales/zh";
import {
  mcpAddProblem,
  mcpAttention,
  mcpFollowUp,
  mcpRowAction,
  mcpShowAddForm,
  mcpShowLoading,
  type McpAddProblem,
} from "./mcp-panel";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { TextFieldInput } from "@/components/ui/text-field";

const MCP_STATUS: Record<McpServerStatus["status"], MessageKey> = {
  connected: "mcp.status.connected",
  disabled: "mcp.status.disabled",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
};

const ADD_PROBLEM: Record<McpAddProblem, MessageKey> = {
  name: "mcp.add.name.invalid",
  command: "mcp.add.command.invalid",
  url: "mcp.add.url.invalid",
};

function mcpDot(status: McpServerStatus["status"]): string {
  if (status === "connected") return "bg-status-active";
  if (status === "failed" || status === "needs_client_registration") return "bg-status-error";
  if (status === "needs_auth") return "bg-status-pending";
  return "bg-muted-foreground/40";
}

/**
 * The header's one mark. Sign-in uses the amber of a person who still has to
 * answer — the pending gray sits too close to the muted icon to read there.
 */
export function McpAttentionMark(props: { tone?: "error" | "pending" }) {
  return (
    <Show when={props.tone}>
      {(tone) => (
        <span
          class={`pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background ${
            tone() === "error" ? "bg-status-error" : "bg-status-cancelled"
          }`}
          aria-hidden="true"
        />
      )}
    </Show>
  );
}

export function useMcpTools(args: {
  sessionId: () => string;
  /** the tools surface only exists on backends that carry MCP (OpenCode) */
  enabled: () => boolean;
  /** the popover and the search popover share an anchor — opening one closes the other */
  onOpen?: () => void;
  onError: (message: string) => void;
}) {
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const [toolsReady, setToolsReady] = createSignal(false);
  const [mcpServers, setMcpServers] = createSignal<[string, McpServerStatus][]>([]);
  const [mcpBusy, setMcpBusy] = createSignal<string>();
  const [mcpNote, setMcpNote] = createSignal<{ name: string; text: string }>();
  const [mcpAddOpen, setMcpAddOpen] = createSignal(false);

  const loadTools = async (report: boolean) => {
    try {
      const mcp = await readMcp(args.sessionId());
      setMcpServers(Object.entries(mcp ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    } catch (err) {
      if (report) args.onError(err instanceof Error ? err.message : t("err.network"));
    } finally {
      setToolsReady(true);
    }
  };

  const toggleTools = () => {
    if (toolsOpen()) {
      setToolsOpen(false);
      setMcpAddOpen(false);
      return;
    }
    args.onOpen?.();
    setMcpNote(undefined);
    if (mcpServers().length === 0) setToolsReady(false);
    setToolsOpen(true);
    void loadTools(true);
  };

  createEffect(() => {
    if (args.enabled()) void loadTools(true);
  });

  const toggleMcp = async (name: string, action: "connect" | "disconnect") => {
    setMcpBusy(name);
    setMcpNote(undefined);
    let follow: ReturnType<typeof mcpFollowUp> = "stay";
    try {
      if (action === "connect") await connectMcp(args.sessionId(), name);
      else await disconnectMcp(args.sessionId(), name);
      await loadTools(false);
      follow = mcpFollowUp(action, mcpServers().find(([n]) => n === name)?.[1].status);
    } catch (err) {
      setMcpNote({ name, text: err instanceof Error ? err.message : t("err.network") });
    } finally {
      setMcpBusy(undefined);
    }
    if (follow === "auth") await beginMcpAuth(name);
  };

  const [mcpKind, setMcpKind] = createSignal<"command" | "url">("url");
  const [mcpName, setMcpName] = createSignal("");
  const [mcpValue, setMcpValue] = createSignal("");
  const [mcpAdding, setMcpAdding] = createSignal(false);
  const [mcpAddErr, setMcpAddErr] = createSignal("");

  // The popover has no refresh control. While it is open, a server can finish
  // connecting after the fetch that opened it, so the same list is read again.
  createEffect(() => {
    if (!args.enabled() || !toolsOpen()) return;
    const timer = setInterval(() => {
      if (mcpBusy() || mcpAdding()) return;
      void loadTools(false);
    }, 5_000);
    onCleanup(() => clearInterval(timer));
  });

  const submitMcp = async (e: Event) => {
    e.preventDefault();
    const name = mcpName().trim();
    const value = mcpValue().trim();
    if (!name || !value || mcpAdding() || mcpAddProblem(mcpKind(), name, value)) return;
    setMcpAdding(true);
    setMcpAddErr("");
    try {
      await addMcp(args.sessionId(), mcpKind() === "command" ? { name, command: value } : { name, url: value });
      setMcpName("");
      setMcpValue("");
      setMcpAddOpen(false);
      await loadTools(false);
    } catch (err) {
      const text = err instanceof Error ? err.message : t("err.network");
      setMcpAddErr(value.length >= 8 && text.includes(value) ? t("mcp.add.failed") : text);
    } finally {
      setMcpAdding(false);
    }
  };

  const [mcpAuth, setMcpAuth] = createSignal<{ name: string; url: string }>();
  const [mcpCode, setMcpCode] = createSignal("");
  let mcpAuthWait: AbortController | undefined;
  onCleanup(() => mcpAuthWait?.abort());

  const cancelMcpAuth = () => {
    mcpAuthWait?.abort();
    mcpAuthWait = undefined;
    setMcpAuth(undefined);
    setMcpCode("");
  };

  const beginMcpAuth = async (name: string) => {
    if (mcpBusy()) return;
    cancelMcpAuth();
    mcpAuthWait = new AbortController();
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      const started = await beginMcpLogin(args.sessionId(), name, mcpAuthWait.signal);
      if ("url" in started && (started.url.startsWith("https://") || started.url.startsWith("http://"))) {
        setMcpAuth({ name, url: started.url });
      } else {
        await loadTools(false);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const text = err instanceof Error ? err.message : t("mcp.auth.failed");
      setMcpNote({ name, text: text || t("mcp.auth.failed") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  const finishMcpAuth = async (name: string) => {
    const code = mcpCode().trim();
    if (!code || mcpBusy()) return;
    mcpAuthWait?.abort();
    mcpAuthWait = new AbortController();
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      await finishMcpLogin(args.sessionId(), name, code, mcpAuthWait.signal);
      setMcpCode("");
      setMcpAuth(undefined);
      await loadTools(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const text = err instanceof Error ? err.message : t("mcp.auth.failed");
      setMcpNote({ name, text: code.length >= 8 && text.includes(code) ? t("mcp.auth.failed") : text || t("mcp.auth.failed") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  return {
    toolsOpen,
    setToolsOpen,
    closeTools: () => {
      setToolsOpen(false);
      setMcpAddOpen(false);
    },
    toggleTools,
    attention: () => mcpAttention(mcpServers().map(([, server]) => server.status)),
    mcpServers,
    mcpBusy,
    mcpNote,
    mcpAddOpen,
    setMcpAddOpen,
    mcpKind,
    setMcpKind,
    mcpName,
    setMcpName,
    mcpValue,
    setMcpValue,
    mcpAdding,
    mcpAddErr,
    setMcpAddErr,
    mcpAuth,
    mcpCode,
    setMcpCode,
    toolsReady,
    submitMcp,
    toggleMcp,
    beginMcpAuth,
    finishMcpAuth,
    cancelMcpAuth,
  };
}

export function McpToolsPanel(props: {
  tools: ReturnType<typeof useMcpTools>;
  /** the body counts as inside itself, so a dismiss elsewhere leaves it be */
  bindPanel: (el: HTMLDivElement | undefined) => void;
  /** LSP health used to sit in the status bar; it reads here with the servers now */
  lsp?: () => LspServer[] | undefined;
}) {
  const m = () => props.tools;
  const showForm = () => mcpShowAddForm(m().toolsReady(), m().mcpServers().length, m().mcpAddOpen());
  const problem = () => mcpAddProblem(m().mcpKind(), m().mcpName(), m().mcpValue());
  let scroller: HTMLDivElement | undefined;
  createEffect(() => {
    if (!m().mcpAddOpen()) return;
    // The form is the last block. Pin its buttons after the row has laid out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scroller) return;
        scroller.scrollTop = scroller.scrollHeight;
      });
    });
  });
  return (
    <div
      ref={props.bindPanel}
      class="absolute right-4 top-11 z-30 w-80 max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <div
        ref={(el) => {
          scroller = el;
        }}
        class="max-h-80 overflow-y-auto px-2 pb-3 pt-2"
      >
        <h2 class="px-1.5 text-2xs font-medium text-muted-foreground">{t("mcp.title")}</h2>
        <Show when={mcpShowLoading(m().toolsReady(), m().mcpServers().length)}>
          <p class="mt-1.5 px-1.5 text-xs text-muted-foreground">{t("mcp.loading")}</p>
        </Show>
        <Show when={m().mcpServers().length > 0}>
          <ul class="mt-1">
            <For each={m().mcpServers()}>
              {([name, server]) => {
                const busy = () => m().mcpBusy() === name;
                const note = () => (m().mcpNote()?.name === name ? m().mcpNote()?.text : undefined);
                const action = () => mcpRowAction(server.status);
                const showAction = () => action() !== undefined && !(action() === "auth" && m().mcpAuth()?.name === name);
                const busyKey = (): MessageKey =>
                  action() === "disconnect" ? "mcp.disconnecting" : action() === "auth" ? "mcp.auth" : "mcp.connecting";
                const actionKey = (): MessageKey =>
                  action() === "disconnect" ? "mcp.disconnect" : action() === "auth" ? "mcp.auth" : "mcp.connect";
                return (
                  <li class="rounded-md px-1.5 py-1.5">
                    <div class="flex items-center gap-2">
                    <span
                      class={`size-1.5 shrink-0 rounded-full ${mcpDot(server.status)} ${busy() ? "motion-safe:animate-pulse" : ""}`}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm">{name}</div>
                      <div
                        class={`truncate text-2xs ${
                          server.status === "connected"
                            ? "text-status-active"
                            : server.status === "failed" || server.status === "needs_client_registration"
                              ? "text-status-error"
                              : "text-muted-foreground"
                        }`}
                      >
                        {busy() ? t(busyKey()) : t(MCP_STATUS[server.status])}
                        <Show
                          when={
                            !busy() &&
                            (server.status === "failed" ||
                              server.status === "needs_client_registration") &&
                            server.error
                          }
                        >
                          {` · ${server.error}`}
                        </Show>
                      </div>
                      <Show when={note()}>
                        <div class="truncate text-2xs text-muted-foreground">{note()}</div>
                      </Show>
                    </div>
                    <Show when={showAction()}>
                      <Button
                        type="button"
                        size="xs"
                        variant="icon"
                        disabled={busy()}
                        onClick={() => {
                          if (action() === "auth") void m().beginMcpAuth(name);
                          else if (action() === "disconnect") void m().toggleMcp(name, "disconnect");
                          else void m().toggleMcp(name, "connect");
                        }}
                      >
                        {busy() ? t(busyKey()) : t(actionKey())}
                      </Button>
                    </Show>
                    </div>
                    <Show when={m().mcpAuth()?.name === name ? m().mcpAuth() : undefined}>
                      {(auth) => (
                        <div class="mt-1.5 pl-3.5">
                          <a
                            class="text-xs text-foreground underline"
                            href={auth().url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("mcp.auth.open")}
                          </a>
                          <p class="mt-1 text-2xs text-muted-foreground">{t("mcp.auth.hint")}</p>
                          <form
                            class="mt-1.5 flex gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void m().finishMcpAuth(name);
                            }}
                          >
                            <TextFieldInput
                              size="xs"
                              class="min-w-0 flex-1"
                              aria-label={t("mcp.auth.code")}
                              placeholder={t("mcp.auth.code")}
                              autocomplete="off"
                              spellcheck={false}
                              value={m().mcpCode()}
                              onInput={(e) => m().setMcpCode(e.currentTarget.value)}
                            />
                            <Button
                              type="submit"
                              size="xs"
                              variant="outline"
                              class="h-7 shrink-0"
                              disabled={busy() || !m().mcpCode().trim()}
                            >
                              {t("mcp.auth.confirm")}
                            </Button>
                          </form>
                          <Button
                            type="button"
                            size="xs"
                            variant="icon"
                            class="mt-1.5"
                            onClick={m().cancelMcpAuth}
                          >
                            {t("mcp.auth.cancel")}
                          </Button>
                        </div>
                      )}
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <Show when={!showForm() && m().mcpServers().length > 0}>
          <div class="mt-2 border-t border-border px-1.5 pt-2">
            <Button type="button" size="xs" variant="quiet" class="px-0" onClick={() => m().setMcpAddOpen(true)}>
              {t("mcp.add")}
            </Button>
          </div>
        </Show>
        <Show when={showForm()}>
          <form
            class={`px-1.5 ${m().mcpServers().length > 0 ? "mt-2 border-t border-border pt-2" : "mt-2"}`}
            onSubmit={(e) => void m().submitMcp(e)}
          >
            <div class="text-2xs font-medium text-muted-foreground">{t("mcp.add")}</div>
            <TextFieldInput
              size="xs"
              value={m().mcpName()}
              aria-label={t("mcp.add.name")}
              placeholder={t("mcp.add.name")}
              class="mt-1.5"
              onInput={(e) => {
                m().setMcpName(e.currentTarget.value);
                m().setMcpAddErr("");
              }}
            />
            <MiniTabs
              kind="radio"
              label={t("mcp.add")}
              value={m().mcpKind()}
              onChange={(id) => {
                m().setMcpKind(id as "url" | "command");
                m().setMcpAddErr("");
              }}
              options={[
                { id: "url", label: t("mcp.add.url") },
                { id: "command", label: t("mcp.add.command") },
              ]}
              class="mt-1.5 gap-1"
            />
            <TextFieldInput
              size="xs"
              mono
              value={m().mcpValue()}
              aria-label={t(m().mcpKind() === "command" ? "mcp.add.command" : "mcp.add.url")}
              placeholder={t(m().mcpKind() === "command" ? "mcp.add.command.placeholder" : "mcp.add.url.placeholder")}
              class="mt-1.5"
              onInput={(e) => {
                m().setMcpValue(e.currentTarget.value);
                m().setMcpAddErr("");
              }}
            />
            <p class="mt-1.5 text-2xs">
              <Show
                when={problem()}
                fallback={<span class="text-muted-foreground">{t("mcp.add.hint")}</span>}
              >
                {(reason) => <span class="text-status-error">{t(ADD_PROBLEM[reason()])}</span>}
              </Show>
            </p>
            <Show when={m().mcpAddErr()}>
              <p class="mt-1 text-2xs text-status-error">{m().mcpAddErr()}</p>
            </Show>
            <div class="mt-1.5 flex items-center gap-1">
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={
                  m().mcpAdding() || !m().mcpName().trim() || !m().mcpValue().trim() || problem() !== undefined
                }
              >
                {t(m().mcpAdding() ? "mcp.add.adding" : "mcp.add.submit")}
              </Button>
              <Show when={m().mcpServers().length > 0}>
                <Button type="button" size="xs" variant="quiet" onClick={() => m().setMcpAddOpen(false)}>
                  {t("mcp.add.cancel")}
                </Button>
              </Show>
            </div>
          </form>
        </Show>
      </div>
      <Show when={props.lsp?.() !== undefined}>
        <div
          class={`border-t border-border px-3.5 py-2 text-2xs ${
            props.lsp!()!.some((s) => s.status === "error") ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {props.lsp!()!.some((s) => s.status === "error")
            ? t("status.lspErr", { n: props.lsp!()!.filter((s) => s.status === "error").length })
            : t("status.lsp", { n: props.lsp!()!.length })}
        </div>
      </Show>
    </div>
  );
}
