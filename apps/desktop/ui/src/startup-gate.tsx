import { createMemo, createResource, Match, onCleanup, Show, Switch } from "solid-js";
import { APP_NAME } from "./app-name";
import { readOpencodeLaunch, type ConnectionAttempt } from "./api";
import { Button } from "./components/ui/button";
import { Icon } from "./icons";
import { t } from "./i18n";
import { cn } from "./lib/utils";
import { openOpencodeLog } from "./opencode-runtime";
import { hostsTrafficLights, inDesktopShell } from "./shell";
import type { StartupStage, SyncProgress } from "./startup";
import { endpointHost } from "./use-connections";

type StepState = "done" | "active" | "pending" | "error";

function serviceStep(stage: StartupStage): StepState {
  if (stage === "service") return "active";
  if (stage === "service-error") return "error";
  return "done";
}

function opencodeStep(stage: StartupStage): StepState {
  if (stage === "service" || stage === "service-error") return "pending";
  if (stage === "opencode") return "active";
  if (stage === "degraded") return "error";
  return "done";
}

function sessionsStep(stage: StartupStage): StepState {
  if (stage === "service" || stage === "service-error" || stage === "opencode") return "pending";
  if (stage === "sessions") return "active";
  if (stage === "sessions-error") return "error";
  return "done";
}

function syncStep(stage: StartupStage): StepState {
  if (stage === "sync") return "active";
  if (stage === "ready") return "done";
  return "pending";
}

function StageMark(props: { state: StepState }) {
  return (
    <Switch>
      <Match when={props.state === "done"}>
        <Icon name="check" class="size-3.5 text-status-active" />
      </Match>
      <Match when={props.state === "error"}>
        <Icon name="alert" class="size-3.5 text-destructive" />
      </Match>
      <Match when={props.state === "active"}>
        <span class="size-3.5 rounded-full border-2 border-muted-foreground/25 border-t-foreground motion-safe:animate-spin" />
      </Match>
      <Match when={props.state === "pending"}>
        <span class="size-1.5 rounded-full bg-muted-foreground/25" />
      </Match>
    </Switch>
  );
}

function StageRow(props: { label: string; state: StepState }) {
  return (
    <li class="flex min-w-0 items-center gap-2.5">
      <span class="grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
        <StageMark state={props.state} />
      </span>
      <span
        class={cn(
          "min-w-0 flex-1 truncate text-sm",
          props.state === "pending"
            ? "text-muted-foreground"
            : props.state === "error"
              ? "text-destructive"
              : "text-foreground",
        )}
      >
        {props.label}
      </span>
    </li>
  );
}

/**
 * One launch, one screen.
 *
 * The app's real surfaces mount only after this is gone, so none of them can
 * paint "service unreachable" over a sidecar that is still coming up. Failures
 * that survive the wait end here too, with the actions that can actually help:
 * retry, open the log, or go and fix the connection.
 */
export function StartupGate(props: {
  stage: StartupStage;
  sync?: SyncProgress;
  attempts: readonly ConnectionAttempt[];
  slow: boolean;
  canEnter: boolean;
  onEnter: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onLogin: () => void;
}) {
  // The embedded server's launch state answers a question the connection
  // list cannot: an address that will not dial may just be a login prompt
  // parked in front of it. While the gate is on screen the state is worth
  // polling — a refused login clears back to the prompt on its own.
  const [launch, { refetch: refetchLaunch }] = createResource(() =>
    readOpencodeLaunch().catch(() => undefined),
  );
  const launchPoll = setInterval(() => void refetchLaunch(), 2_000);
  onCleanup(() => clearInterval(launchPoll));

  const needsLogin = () => {
    const state = launch()?.state;
    return state === "authRequired" || state === "authFailed";
  };

  const copy = createMemo(() => {
    if (
      needsLogin() &&
      (props.stage === "opencode" || props.stage === "degraded")
    ) {
      return { title: t("startup.authRequired"), hint: t("startup.authRequiredHint") };
    }
    switch (props.stage) {
      case "service":
        return { title: t("startup.service"), hint: t("startup.serviceHint") };
      case "service-error":
        return { title: t("startup.serviceError"), hint: t("startup.serviceErrorHint") };
      case "opencode":
        return { title: t("startup.opencode"), hint: t("startup.opencodeHint") };
      case "sessions":
        return { title: t("startup.sessions"), hint: t("startup.sessionsHint") };
      case "sessions-error":
        return { title: t("startup.sessionsError"), hint: t("startup.sessionsErrorHint") };
      case "sync":
        return { title: t("startup.sync"), hint: t("startup.syncHint") };
      case "degraded":
        return { title: t("startup.degraded"), hint: t("startup.degradedHint") };
      default:
        return { title: t("startup.service"), hint: t("startup.serviceHint") };
    }
  });

  const targets = createMemo(() =>
    props.attempts
      .filter((attempt) => attempt.phase === "failed")
      .map((attempt) => endpointHost(attempt.endpoint))
      .join(" · "),
  );

  const percent = () => {
    const s = props.sync;
    if (!s || s.indeterminate || s.total <= 0) return 0;
    return Math.min(100, Math.round((s.done / s.total) * 100));
  };

  const syncLabel = () => {
    const s = props.sync;
    if (!s || s.total <= 0) return t("startup.syncScanning");
    return t("startup.syncCount", { done: s.done, total: s.total });
  };

  const openLog = () => {
    void openOpencodeLog().catch(() => {});
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <Show when={hostsTrafficLights()}>
        <div class="h-11 shrink-0" data-tauri-drag-region="" />
      </Show>
      <div class="flex flex-1 items-center justify-center px-6 py-10">
        <div class="w-full max-w-[420px]">
          <p class="sr-only" role="status" aria-live="polite">
            {copy().title}
          </p>
          <div class="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" draggable={false} class="size-8 shrink-0" />
            <span class="text-sm font-medium">{APP_NAME}</span>
          </div>

          <h1 class="mt-6 text-lg font-medium">{copy().title}</h1>
          <p class="mt-1.5 text-sm leading-6 text-muted-foreground">{copy().hint}</p>

          <ol class="mt-7 space-y-3" aria-label={t("startup.steps")}>
            <StageRow label={t("startup.step.service")} state={serviceStep(props.stage)} />
            <StageRow label={t("startup.step.opencode")} state={opencodeStep(props.stage)} />
            <StageRow label={t("startup.step.sessions")} state={sessionsStep(props.stage)} />
            <StageRow label={t("startup.step.sync")} state={syncStep(props.stage)} />
          </ol>

          <Show when={props.stage === "sync"}>
            <div class="mt-4">
              <div
                class="h-1 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label={syncLabel()}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  props.sync && !props.sync.indeterminate ? percent() : undefined
                }
              >
                <div
                  class={cn(
                    "h-full rounded-full bg-foreground/40 transition-[width] duration-300",
                    (!props.sync || props.sync.indeterminate) &&
                      "w-1/3 motion-safe:animate-pulse",
                  )}
                  style={
                    props.sync && !props.sync.indeterminate
                      ? { width: `${percent()}%` }
                      : undefined
                  }
                />
              </div>
              <p class="mt-1.5 font-mono text-2xs tabular-nums text-muted-foreground">
                {syncLabel()}
              </p>
            </div>
          </Show>

          <Show when={props.stage === "degraded" && targets().length > 0}>
            <p class="mt-3 truncate font-mono text-2xs text-muted-foreground" title={targets()}>
              {t("startup.attempts", { targets: targets() })}
            </p>
          </Show>

          <div class="mt-6 flex flex-wrap items-center gap-2">
            <Show when={props.stage === "service-error" || props.stage === "sessions-error"}>
              <>
                <Button size="sm" onClick={props.onRetry}>
                  {t("startup.retry")}
                </Button>
                <Show when={inDesktopShell()}>
                  <Button variant="ghost" size="sm" onClick={openLog}>
                    {t("startup.log")}
                  </Button>
                </Show>
              </>
            </Show>

            {/* A parked domain-login prompt is what "cannot connect" means
                for the fork: point at the form that answers it, not at the
                backend list where no login lives. */}
            <Show when={needsLogin() && (props.stage === "opencode" || props.stage === "degraded")}>
              <>
                <Button size="sm" onClick={props.onLogin}>
                  {t("startup.login")}
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onEnter}>
                  {t("startup.enterLocal")}
                </Button>
              </>
            </Show>

            <Show when={props.stage === "degraded" && !needsLogin()}>
              <>
                <Button size="sm" onClick={props.onSettings}>
                  {t("startup.settings")}
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onEnter}>
                  {t("startup.enterLocal")}
                </Button>
              </>
            </Show>

            <Show when={props.stage === "sync" && props.slow}>
              <Button size="sm" onClick={props.onEnter}>
                {t("startup.enter")}
              </Button>
            </Show>

            <Show when={props.stage === "opencode" && props.slow && !needsLogin()}>
              <>
                <Button variant="ghost" size="sm" onClick={props.onSettings}>
                  {t("startup.settings")}
                </Button>
                <Show when={props.canEnter}>
                  <Button variant="ghost" size="sm" onClick={props.onEnter}>
                    {t("startup.enterLocal")}
                  </Button>
                </Show>
              </>
            </Show>

            <Show
              when={
                (props.stage === "service" || props.stage === "sessions") &&
                props.slow &&
                inDesktopShell()
              }
            >
              <Button variant="ghost" size="sm" onClick={openLog}>
                {t("startup.log")}
              </Button>
            </Show>
          </div>

          <Show when={props.slow}>
            <p class="mt-4 text-2xs text-muted-foreground">{t("startup.slow")}</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
