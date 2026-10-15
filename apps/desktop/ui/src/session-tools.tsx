import { createEffect, createSignal, onCleanup, For, Show } from "solid-js";
import {
  addMcp,
  beginMcpLogin,
  connectMcp,
  disconnectMcp,
  finishMcpLogin,
  readMcp,
  type McpServerStatus,
} from "./api";
import { t } from "./i18n";
import type { MessageKey } from "./locales/zh";
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

function mcpDot(status: McpServerStatus["status"]): string {
  if (status === "connected") return "bg-status-active";
  if (status === "failed" || status === "needs_client_registration") return "bg-status-error";
  if (status === "needs_auth") return "bg-status-pending";
  return "bg-muted-foreground/40";
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

  const loadTools = async () => {
    try {
      const mcp = await readMcp(args.sessionId());
      setMcpServers(Object.entries(mcp ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    } catch (err) {
      args.onError(err instanceof Error ? err.message : t("err.network"));
    } finally {
      setToolsReady(true);
    }
  };

  const toggleTools = () => {
    if (toolsOpen()) {
      setToolsOpen(false);
      return;
    }
    args.onOpen?.();
    setMcpNote(undefined);
    setToolsReady(false);
    setToolsOpen(true);
    void loadTools();
  };

  createEffect(() => {
    if (args.enabled()) void loadTools();
  });

  const toggleMcp = async (name: string, action: "connect" | "disconnect") => {
    const before = mcpServers().find(([n]) => n === name)?.[1].status;
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      if (action === "connect") await connectMcp(args.sessionId(), name);
      else await disconnectMcp(args.sessionId(), name);
      await loadTools();
      const after = mcpServers().find(([n]) => n === name)?.[1].status;
      if (after === before) setMcpNote({ name, text: t("mcp.unchanged") });
    } catch (err) {
      setMcpNote({ name, text: err instanceof Error ? err.message : t("err.network") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  const [mcpKind, setMcpKind] = createSignal<"command" | "url">("url");
  const [mcpName, setMcpName] = createSignal("");
  const [mcpValue, setMcpValue] = createSignal("");
  const [mcpAdding, setMcpAdding] = createSignal(false);
  const [mcpAddErr, setMcpAddErr] = createSignal("");

  const submitMcp = async (e: Event) => {
    e.preventDefault();
    const name = mcpName().trim();
    const value = mcpValue().trim();
    if (!name || !value || mcpAdding()) return;
    setMcpAdding(true);
    setMcpAddErr("");
    try {
      await addMcp(args.sessionId(), mcpKind() === "command" ? { name, command: value } : { name, url: value });
      setMcpName("");
      setMcpValue("");
      await loadTools();
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
        await loadTools();
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
      await loadTools();
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
    toggleTools,
    mcpServers,
    mcpBusy,
    mcpNote,
    mcpKind,
    setMcpKind,
    mcpName,
    setMcpName,
    mcpValue,
    setMcpValue,
    mcpAdding,
    mcpAddErr,
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

export function McpToolsPanel(props: { tools: ReturnType<typeof useMcpTools> }) {
  const m = () => props.tools;
  return (
    <div class="absolute right-4 top-11 z-30 w-80 max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      <div class="max-h-80 overflow-y-auto px-2 py-2">
        <h2 class="px-1.5 text-2xs font-medium text-muted-foreground">{t("mcp.title")}</h2>
        <Show when={m().toolsReady() && m().mcpServers().length === 0}>
          <p class="mt-1.5 px-1.5 text-xs text-muted-foreground">{t("mcp.empty")}</p>
        </Show>
        <Show when={m().mcpServers().length > 0}>
          <ul class="mt-1">
            <For each={m().mcpServers()}>
              {([name, server]) => {
                const busy = () => m().mcpBusy() === name;
                const note = () => (m().mcpNote()?.name === name ? m().mcpNote()?.text : undefined);
                const canDisconnect = () => server.status === "connected";
                const canConnect = () => server.status === "disabled" || server.status === "failed";
                const canAuth = () => server.status === "needs_auth" && m().mcpAuth()?.name !== name;
                return (
                  <li class="rounded-md px-1.5 py-1.5">
                    <div class="flex items-center gap-2">
                    <span
                      class={`size-1.5 shrink-0 rounded-full ${mcpDot(server.status)} ${busy() ? "animate-pulse" : ""}`}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm">{name}</div>
                      <div
                        class={`truncate text-2xs ${
                          server.status === "connected"
                            ? "text-status-active"
                            : server.status === "failed"
                              ? "text-status-error"
                              : "text-muted-foreground"
                        }`}
                      >
                        {busy()
                          ? t(
                              canDisconnect()
                                ? "mcp.disconnecting"
                                : canAuth()
                                  ? "mcp.auth"
                                  : "mcp.connecting",
                            )
                          : t(MCP_STATUS[server.status])}
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
                    <Show when={canDisconnect() || canConnect() || canAuth()}>
                      <Button
                        type="button"
                        size="xs"
                        variant="icon"
                        disabled={busy()}
                        onClick={() => {
                          if (canAuth()) void m().beginMcpAuth(name);
                          else void m().toggleMcp(name, canDisconnect() ? "disconnect" : "connect");
                        }}
                      >
                        {busy()
                          ? t(canDisconnect() ? "mcp.disconnecting" : canAuth() ? "mcp.auth" : "mcp.connecting")
                          : t(canDisconnect() ? "mcp.disconnect" : canAuth() ? "mcp.auth" : "mcp.connect")}
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
        <Show when={m().toolsReady()}>
          <form class="mt-2 border-t border-border px-1.5 pt-2" onSubmit={(e) => void m().submitMcp(e)}>
            <div class="text-2xs font-medium text-muted-foreground">{t("mcp.add")}</div>
            <TextFieldInput
              size="xs"
              value={m().mcpName()}
              placeholder={t("mcp.add.name")}
              class="mt-1.5"
              onInput={(e) => m().setMcpName(e.currentTarget.value)}
            />
            <MiniTabs
              kind="radio"
              label={t("mcp.add")}
              value={m().mcpKind()}
              onChange={(id) => m().setMcpKind(id as "url" | "command")}
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
              placeholder={t(m().mcpKind() === "command" ? "mcp.add.command.placeholder" : "mcp.add.url.placeholder")}
              class="mt-1.5"
              onInput={(e) => m().setMcpValue(e.currentTarget.value)}
            />
            <p class="mt-1.5 text-2xs text-muted-foreground">{t("mcp.add.hint")}</p>
            <Show when={m().mcpAddErr()}>
              <p class="mt-1 text-2xs text-status-error">{m().mcpAddErr()}</p>
            </Show>
            <Button
              type="submit"
              size="xs"
              variant="outline"
              class="mt-1.5"
              disabled={m().mcpAdding() || !m().mcpName().trim() || !m().mcpValue().trim()}
            >
              {t(m().mcpAdding() ? "mcp.add.adding" : "mcp.add.submit")}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  );
}
