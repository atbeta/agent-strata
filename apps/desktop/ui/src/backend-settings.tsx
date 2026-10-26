import { For, Show } from "solid-js";
import { backendLabel } from "./api";
import { settled } from "./resource";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";
import { Card, Group, Segmented } from "./settings-blocks";
import { endpointShort, type ConnectionsCtl } from "./use-connections";
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

const fieldLabel = "block text-2xs text-muted-foreground mb-1";

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
      <Group label={t("settings.backends.connected")} hint={t("settings.backends.history")}>
        <Card class="px-0">
          <Show
            when={live().length > 0}
            fallback={
              <p class="px-4 py-3 text-sm text-muted-foreground">{t("settings.backends.none")}</p>
            }
          >
            <For each={live()}>
              {(conn) => (
                <div class="flex flex-col gap-2.5 px-4 py-3 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:gap-3">
                  <div class="flex shrink-0 items-center gap-2.5">
                    <span class="size-1.5 shrink-0 rounded-full bg-status-active" />
                    <span class="text-sm font-medium">{backendLabel(conn.backend)}</span>
                    <Show when={placementWord(conn.placement)}>
                      {(word) => (
                        <span class="rounded bg-secondary/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {word()}
                        </span>
                      )}
                    </Show>
                  </div>
                  <span
                    class="min-w-0 truncate font-mono text-2xs text-muted-foreground @min-[560px]/main:flex-1"
                    title={conn.baseUrl}
                  >
                    {conn.baseUrl}
                  </span>
                  <div class="flex shrink-0 flex-wrap items-center gap-2">
                    <Show when={live().length > 1 && c().newSessionConnection() !== conn.id}>
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => c().chooseNewConn(conn.id)}
                      >
                        {t("settings.backends.useForNew")}
                      </Button>
                    </Show>
                    <Show when={live().length > 1 && c().newSessionConnection() === conn.id}>
                      <span class="text-2xs text-muted-foreground">
                        {t("sidebar.backend.newTarget")}
                      </span>
                    </Show>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => c().disconnect(conn.id)}
                    >
                      {t("settings.backends.disconnect")}
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Card>
      </Group>

      <Show when={pending().length > 0}>
        <Group label={t("settings.backends.pending")}>
          <Card class="px-0">
            <For each={pending()}>
              {(attempt) => (
                <div class="flex flex-col gap-2.5 px-4 py-3 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:gap-3">
                  <span class="min-w-0 truncate text-sm @min-[560px]/main:flex-1">
                    <span class="font-medium">{backendLabel(attempt.backend)}</span>
                    <span class="font-mono text-2xs text-muted-foreground">
                      {" "}
                      · {attemptLine(attempt)}
                    </span>
                  </span>
                  <div class="flex shrink-0 items-center gap-2">
                    <span class="text-2xs text-muted-foreground">
                      {attempt.phase === "retrying"
                        ? t("sidebar.backend.connecting")
                        : t("sidebar.backend.failed")}
                    </span>
                    <Show when={attempt.phase === "failed"}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => c().forget(attempt.endpoint)}
                      >
                        {t("settings.backends.forget")}
                      </Button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Card>
        </Group>
      </Show>

      <Group label={t("settings.backends.add")}>
        <Card>
          <div class="py-3">
            <Segmented
              label={t("settings.backends.add")}
              value={c().connKind()}
              onChange={(id) => c().setConnKind(id as "opencode" | "acp")}
              options={[
                { id: "opencode", label: t("connect.kind.opencode") },
                { id: "acp", label: t("connect.kind.acp") },
              ]}
            />
          </div>

          <div class="space-y-3 py-3">
            <Show
              when={c().connKind() === "acp"}
              fallback={
                <>
                  <div>
                    <label class={fieldLabel} for="connect-url">
                      {t("connect.form.url")}
                    </label>
                    <TextFieldInput
                      id="connect-url"
                      size="sm"
                      mono
                      value={c().connUrl()}
                      onInput={(e) => c().setConnUrl(e.currentTarget.value)}
                      class="bg-background"
                      placeholder="http://127.0.0.1:4096"
                    />
                  </div>
                  <div class="grid grid-cols-3 gap-2 @max-[560px]/main:grid-cols-1">
                    <div>
                      <label class={fieldLabel} for="connect-name">
                        {t("connect.form.name")}
                      </label>
                      <TextFieldInput
                        id="connect-name"
                        size="sm"
                        value={c().connName()}
                        onInput={(e) => c().setConnName(e.currentTarget.value)}
                        class="bg-background"
                      />
                    </div>
                    <div>
                      <label class={fieldLabel} for="connect-user">
                        {t("connect.form.user")}
                      </label>
                      <TextFieldInput
                        id="connect-user"
                        size="sm"
                        value={c().connUser()}
                        onInput={(e) => c().setConnUser(e.currentTarget.value)}
                        class="bg-background"
                      />
                    </div>
                    <div>
                      <label class={fieldLabel} for="connect-pass">
                        {t("connect.form.password")}
                      </label>
                      <TextFieldInput
                        id="connect-pass"
                        size="sm"
                        type="password"
                        value={c().connPass()}
                        onInput={(e) => c().setConnPass(e.currentTarget.value)}
                        class="bg-background"
                      />
                    </div>
                  </div>
                </>
              }
            >
              <div>
                <label class={fieldLabel} for="connect-cmd">
                  {t("connect.form.command")}
                </label>
                <TextFieldInput
                  id="connect-cmd"
                  size="sm"
                  mono
                  value={c().connCmd()}
                  onInput={(e) => c().setConnCmd(e.currentTarget.value)}
                  class="bg-background"
                  placeholder="opencode acp"
                />
              </div>
              <div>
                <label class={fieldLabel} for="connect-name">
                  {t("connect.form.name")}
                </label>
                <TextFieldInput
                  id="connect-name"
                  size="sm"
                  value={c().connName()}
                  onInput={(e) => c().setConnName(e.currentTarget.value)}
                  class="bg-background"
                />
              </div>
            </Show>
          </div>

          <div class="py-3">
            <Show when={c().connErr()}>
              <p class="mb-2 flex items-center gap-1.5 text-2xs text-destructive">
                <Icon name="alert" class="size-3 shrink-0" />
                {c().connErr()}
              </p>
            </Show>
            <div class="flex justify-end">
              <Button
                size="sm"
                disabled={
                  c().connecting() ||
                  !(c().connKind() === "acp" ? c().connCmd().trim() : c().connUrl().trim())
                }
                onClick={() => void c().connect()}
              >
                {c().connecting() ? t("action.connecting") : t("action.connect")}
              </Button>
            </div>
          </div>
        </Card>
      </Group>
    </>
  );
}
