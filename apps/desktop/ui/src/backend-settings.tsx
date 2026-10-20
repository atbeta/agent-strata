import { For, Show } from "solid-js";
import { backendLabel } from "./api";
import { settled } from "./resource";
import { t } from "./i18n";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";
import { Group } from "./settings-blocks";
import { endpointHost, endpointShort, type ConnectionsCtl } from "./use-connections";
import type { ConnectionAttempt, ConnectionPlacement } from "./api";

function placementWord(placement: ConnectionPlacement | undefined): string {
  if (placement === "embed") return t("connect.placement.embed");
  if (placement === "external") return t("connect.placement.external");
  return "";
}

function attemptLine(attempt: ConnectionAttempt): string {
  const place = placementWord(attempt.placement);
  const host = endpointShort(attempt.endpoint);
  return place ? `${host} · ${place}` : host;
}

/**
 * The connected backends, and the addresses the app still means to dial.
 *
 * The sidebar corner only says which ones are up. Connecting, disconnecting
 * and dropping a remembered address are the same actions for every backend,
 * so they live on this one page.
 */
export function BackendSettings(props: { conns: ConnectionsCtl }) {
  const c = () => props.conns;
  const live = () => settled(c().conns)?.connections ?? [];
  const pending = () =>
    c().attempts().filter((attempt) => !live().some((conn) => conn.baseUrl === attempt.endpoint));

  return (
    <>
      <Group label={t("settings.backends.connected")}>
        <p class="mb-2 text-2xs leading-4 text-muted-foreground">{t("settings.backends.history")}</p>
        <Show
          when={live().length > 0}
          fallback={<p class="text-sm text-muted-foreground">{t("settings.backends.none")}</p>}
        >
          <ul class="divide-y divide-border">
            <For each={live()}>
              {(conn) => (
                <li class="flex items-center gap-3 py-2.5">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" />
                  <span class="min-w-0 flex-1 truncate text-sm">
                    {backendLabel(conn.backend)}
                    <Show when={placementWord(conn.placement)}>
                      {(word) => <span class="text-2xs text-muted-foreground"> {word()}</span>}
                    </Show>
                    <span class="font-mono text-2xs text-muted-foreground"> · {endpointHost(conn.baseUrl)}</span>
                  </span>
                  <Show when={live().length > 1 && c().newSessionConnection() !== conn.id}>
                    <Button size="xs" variant="quiet" onClick={() => c().chooseNewConn(conn.id)}>
                      {t("settings.backends.useForNew")}
                    </Button>
                  </Show>
                  <Show when={live().length > 1 && c().newSessionConnection() === conn.id}>
                    <span class="text-2xs text-muted-foreground">{t("sidebar.backend.newTarget")}</span>
                  </Show>
                  <Button size="xs" variant="quiet" onClick={() => c().disconnect(conn.id)}>
                    {t("settings.backends.disconnect")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Group>

      <Show when={pending().length > 0}>
        <Group label={t("settings.backends.pending")}>
          <ul class="divide-y divide-border">
            <For each={pending()}>
              {(attempt) => (
                <li class="flex items-center gap-3 py-2.5">
                  <span class="min-w-0 flex-1 truncate text-sm">
                    {backendLabel(attempt.backend)}
                    <span class="font-mono text-2xs text-muted-foreground"> · {attemptLine(attempt)}</span>
                  </span>
                  <span class="text-2xs text-muted-foreground">
                    {attempt.phase === "retrying" ? t("sidebar.backend.connecting") : t("sidebar.backend.failed")}
                  </span>
                  <Show when={attempt.phase === "failed"}>
                    <Button size="xs" variant="quiet" onClick={() => c().forget(attempt.endpoint)}>
                      {t("settings.backends.forget")}
                    </Button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Group>
      </Show>

      <Group label={t("settings.backends.add")}>
        <div class="space-y-1.5">
          <div class="flex gap-1">
            <Button
              size="sm"
              variant={c().connKind() === "opencode" ? "secondary" : "ghost"}
              class="h-7 flex-1 text-2xs"
              onClick={() => c().setConnKind("opencode")}
            >
              {t("connect.kind.opencode")}
            </Button>
            <Button
              size="sm"
              variant={c().connKind() === "acp" ? "secondary" : "ghost"}
              class="h-7 flex-1 text-2xs"
              onClick={() => c().setConnKind("acp")}
            >
              {t("connect.kind.acp")}
            </Button>
          </div>
          <Show
            when={c().connKind() === "acp"}
            fallback={
              <>
                <TextFieldInput
                  size="sm"
                  mono
                  value={c().connUrl()}
                  onChange={c().setConnUrl}
                  class="bg-background text-2xs"
                  placeholder="http://127.0.0.1:4096"
                />
                <div class="flex gap-1.5">
                  <TextFieldInput
                    size="sm"
                    value={c().connName()}
                    onChange={c().setConnName}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.name")}
                  />
                  <TextFieldInput
                    size="sm"
                    value={c().connUser()}
                    onChange={c().setConnUser}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.user")}
                  />
                  <TextFieldInput
                    size="sm"
                    type="password"
                    value={c().connPass()}
                    onChange={c().setConnPass}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.password")}
                  />
                </div>
              </>
            }
          >
            <TextFieldInput
              size="sm"
              mono
              value={c().connCmd()}
              onChange={c().setConnCmd}
              class="bg-background text-2xs"
              placeholder={t("connect.form.command")}
            />
            <TextFieldInput
              size="sm"
              value={c().connName()}
              onChange={c().setConnName}
              class="bg-background px-2 text-2xs"
              placeholder={t("connect.form.name")}
            />
          </Show>
          <Show when={c().connErr()}>
            <p class="font-mono text-2xs text-destructive">{c().connErr()}</p>
          </Show>
          <Button
            class="h-8"
            disabled={c().connecting() || !(c().connKind() === "acp" ? c().connCmd().trim() : c().connUrl().trim())}
            onClick={() => void c().connect()}
          >
            {c().connecting() ? t("action.connecting") : t("action.connect")}
          </Button>
        </div>
      </Group>
    </>
  );
}
