import { createEffect, createResource, createSignal, Show } from "solid-js";
import {
  readOpencodeLaunch,
  saveOpencodeMode,
  type OpencodeApiVersion,
  type OpencodeLaunchMode,
  type OpencodeRuntime,
} from "./api";
import {
  checkOpencodeRuntime,
  chooseOpencodeBinary,
  opencodeLogin,
  restartOpencode,
  setOpencodeBinary,
} from "./opencode-runtime";
import { settled } from "./resource";
import { inDesktopShell } from "./shell";
import { stamp, t } from "./i18n";
import { fadeSignal } from "./errors";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { Card, Group, Row, Segmented } from "./settings-blocks";
import { runtimeErrorText } from "./runtime-error";
import { Tip } from "./tip";
import type { ConnectionsCtl } from "./use-connections";

/**
 * The OpenCode the app starts on this machine: whether it does, how it is
 * doing, and the binary behind it.
 *
 * It sits at the top of the page that lists the servers because it is one of
 * them — the one the app runs itself. Turning it off is the same picture with
 * one server fewer, not a different mode of the app.
 */
export function EngineSettings(props: { conns: ConnectionsCtl }) {
  const [launch, { refetch: refetchLaunch }] = createResource(readOpencodeLaunch);
  const [mode, setMode] = createSignal<OpencodeLaunchMode>("embed");
  const [apiVersion, setApiVersion] = createSignal<OpencodeApiVersion>("v1");
  const [runtime, setRuntime] = createSignal<OpencodeRuntime>();
  const [runtimeBusy, setRuntimeBusy] = createSignal(false);
  const [runtimeErr, setRuntimeErr] = fadeSignal("");
  const [runtimeNote, setRuntimeNote] = fadeSignal("");
  const [restartArmed, setRestartArmed] = createSignal(false);
  const [hydrated, setHydrated] = createSignal(false);
  const [saveErr, setSaveErr] = fadeSignal("");
  const [loginUser, setLoginUser] = createSignal("");
  const [loginPass, setLoginPass] = createSignal("");
  const [loginBusy, setLoginBusy] = createSignal(false);
  const [details, setDetails] = createSignal(false);

  const launchData = () => (launch.error ? undefined : launch());
  const live = () => settled(props.conns.conns)?.connections ?? [];
  /** The connection the shell's own server answers on, once the service has made it. */
  const engineConnection = () => live().find((conn) => conn.placement === "embed");
  // The binary is upkeep, folded away — until something about it is wrong,
  // when it is the thing to look at.
  const binaryTrouble = () =>
    runtime()?.source === "missing" || runtime()?.error !== undefined || runtimeErr() !== "";
  const showDetails = () => details() || binaryTrouble();

  const runtimeSource = () => {
    switch (runtime()?.source) {
      case "setting":
        return t("settings.opencode.sourceShort.setting");
      case "env":
        return t("settings.opencode.sourceShort.env");
      case "path":
        return t("settings.opencode.sourceShort.path");
      case "missing":
        return t("settings.opencode.sourceShort.missing");
      case "external":
        return t("settings.opencode.sourceShort.external");
      default:
        return "—";
    }
  };
  const runtimeTone = () => {
    switch (launchData()?.state) {
      case "running":
        return "bg-status-active";
      case "missing":
      case "stopped":
        return "bg-status-error";
      case "starting":
      case "restarting":
      case "authRequired":
        return "bg-status-cancelled";
      case "authFailed":
        return "bg-status-error";
      default:
        return "bg-status-pending";
    }
  };
  const runtimeState = () => {
    switch (launchData()?.state) {
      case "starting":
        return t("settings.opencode.state.starting");
      case "running":
        return t("settings.opencode.state.running");
      case "missing":
        return t("settings.opencode.state.missing");
      case "restarting":
        return t("settings.opencode.state.restarting");
      case "stopped":
        return t("settings.opencode.state.stopped");
      case "external":
        return t("settings.opencode.state.external");
      case "authRequired":
        return t("settings.opencode.state.authRequired");
      case "authFailed":
        return t("settings.opencode.state.authFailed");
      case "unmanaged":
        return t("settings.opencode.state.unmanaged");
      default:
        return "—";
    }
  };
  const checkRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const report = await checkOpencodeRuntime();
      if (report) setRuntime(report);
      else setRuntimeErr(t("settings.opencode.desktopOnly"));
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const pickRuntime = async () => {
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const picked = await chooseOpencodeBinary(t("settings.opencode.chooseBin"));
      if (!picked) return;
      setRuntimeBusy(true);
      const report = await setOpencodeBinary(picked);
      if (report) {
        setRuntime(report);
        setRuntimeNote(t("settings.opencode.binSaved"));
      }
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const clearRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const report = await setOpencodeBinary(null);
      if (report) {
        setRuntime(report);
        setRuntimeNote(t("settings.opencode.binCleared"));
      }
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const restartRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    setRestartArmed(false);
    try {
      await restartOpencode();
      // The supervisor reacts on its next five-second beat, then the new
      // server has to become healthy. Poll rather than claiming success.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = await readOpencodeLaunch();
        if (next.state === "running") {
          setRuntime(next.runtime);
          await refetchLaunch();
          setRuntimeNote(t("settings.opencode.restarted"));
          // The service connects from the status file on its own; give it a
          // moment, then let the server list show the row it made.
          props.conns.refetchConns();
          setTimeout(() => props.conns.refetchConns(), 2_500);
          return;
        }
        if (next.state === "missing" || next.state === "stopped") {
          throw new Error(t("settings.opencode.restartFailed"));
        }
        // A parked login prompt is a terminal answer for the wait, not a slow
        // one — stop so the form below becomes the thing to do next.
        if (next.state === "authRequired" || next.state === "authFailed") {
          await refetchLaunch();
          return;
        }
      }
      setRuntimeNote(t("settings.opencode.restartSlow"));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setRuntimeErr(
        message.includes("not being supervised")
          ? t("settings.opencode.restartFailed")
          : message || t("err.network"),
      );
    } finally {
      setRuntimeBusy(false);
    }
  };
  const armRestart = () => {
    if (!restartArmed()) {
      setRestartArmed(true);
      setTimeout(() => setRestartArmed(false), 4000);
      return;
    }
    setRestartArmed(false);
    void restartRuntime();
  };
  const submitLogin = async () => {
    const username = loginUser().trim();
    const password = loginPass();
    if (!username || !password || loginBusy()) return;
    setLoginBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      await opencodeLogin(username, password);
      // The fork checks the pair itself: a refusal flips the launch state to
      // authFailed within a moment, a good one ends in running — and the
      // service connects off the status file on its own.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = await readOpencodeLaunch();
        if (next.state === "running") {
          setLoginPass("");
          setRuntime(next.runtime);
          await refetchLaunch();
          setRuntimeNote(t("settings.opencode.restarted"));
          props.conns.refetchConns();
          setTimeout(() => props.conns.refetchConns(), 2_500);
          return;
        }
        if (next.state === "authFailed" || next.state === "stopped" || next.state === "missing") {
          break;
        }
      }
      await refetchLaunch();
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setLoginBusy(false);
    }
  };

  createEffect(() => {
    if (hydrated()) return;
    const data = launchData();
    if (data) {
      setMode(data.mode);
      setApiVersion(data.apiVersion ?? "v1");
      setRuntime(data.runtime);
      setHydrated(true);
    } else if (launch.error) {
      setHydrated(true);
    }
  });

  const pickMode = async (next: OpencodeLaunchMode) => {
    if (next === mode()) return;
    const previous = mode();
    setHydrated(true);
    setMode(next);
    setSaveErr("");
    try {
      await saveOpencodeMode(next);
      // The saved mode decides what the state row offers — start for embed,
      // nothing external — so it cannot be left showing the previous choice.
      await refetchLaunch();
    } catch (e) {
      setMode(previous);
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  };

  const pickApiVersion = async (next: OpencodeApiVersion) => {
    if (next === apiVersion()) return;
    const previous = apiVersion();
    setApiVersion(next);
    setSaveErr("");
    try {
      await saveOpencodeMode(mode(), next);
      await refetchLaunch();
      if (inDesktopShell()) await checkRuntime();
      else setRuntime(launchData()?.runtime);
    } catch (e) {
      setApiVersion(previous);
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  };

  const parked = () => launchData()?.state === "authRequired" || launchData()?.state === "authFailed";

  return (
    <Group label={t("settings.engine.title")} hint={t("settings.engine.hint")}>
      <Card>
        {/* The saved mode is a lifecycle answer — does the app start its own
            OpenCode — not a place: a server the reader runs on this machine
            is as local as the engine. An on/off switch keeps it from reading
            as a second local/remote pair. */}
        <Row
          label={t("settings.opencode.mode")}
          hint={mode() === "embed" ? t("settings.opencode.modeOn") : t("settings.opencode.modeOff")}
          note={
            <>
              <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">{t("settings.opencode.apply")}</p>
              <Show when={saveErr()}>
                <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                  <Icon name="alert" class="size-3 shrink-0" />
                  {saveErr()}
                </p>
              </Show>
            </>
          }
        >
          <Switch
            checked={mode() === "embed"}
            aria-label={t("settings.opencode.mode")}
            onChange={(on) => void pickMode(on ? "embed" : "external")}
          />
        </Row>

        {/* Keyed on the chosen mode rather than the running one, so switching
            it on shows where its binary will come from. `mode` reads "embed"
            until the saved choice arrives; waiting for it keeps an engine that
            is off from flashing these rows on open. */}
        <Show when={hydrated() && mode() !== "external"}>
          <Row
            label={t("settings.opencode.apiVersion")}
            hint={t("settings.opencode.apiVersionHint")}
          >
            <Segmented
              label={t("settings.opencode.apiVersion")}
              value={apiVersion()}
              options={[
                { id: "v1", label: "v1" },
                { id: "v2", label: "v2" },
              ]}
              onChange={(next) => void pickApiVersion(next as OpencodeApiVersion)}
            />
          </Row>
          <Row
            label={t("settings.opencode.state")}
            note={
              <>
                <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                  <span aria-hidden="true" class={`size-1.5 shrink-0 rounded-full ${runtimeTone()}`} />
                  {runtimeState()}
                </p>
                <Show when={runtimeNote()}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Icon name="check" class="size-3 shrink-0" />
                    {runtimeNote()}
                  </p>
                </Show>
                <Show when={engineConnection()?.plugins === false}>
                  <p class="mt-1.5 flex items-start gap-1.5 text-2xs leading-4 text-muted-foreground">
                    <Icon name="alert" class="mt-0.5 size-3 shrink-0" />
                    {t("settings.opencode.pluginsMissing")}
                  </p>
                </Show>
                <Show when={launchData()?.state === "missing"}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {t("settings.opencode.missing")}{" "}
                    <a
                      href="https://opencode.ai"
                      target="_blank"
                      rel="noreferrer"
                      class="underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                    >
                      {t("settings.opencode.install")}
                    </a>
                  </p>
                </Show>
              </>
            }
          >
            <div class="flex flex-wrap items-center justify-end gap-2">
              {/* Which server a new session lands on is the reader's choice,
                  and the engine is one of the choices. */}
              <Show when={engineConnection() && live().length > 1 ? engineConnection() : undefined}>
                {(conn) => (
                  <Show
                    when={props.conns.newSessionConnection() !== conn().id}
                    fallback={
                      <Tip label={t("settings.backends.useForNewHint")}>
                        <span class="text-2xs text-muted-foreground">{t("sidebar.backend.newTarget")}</span>
                      </Tip>
                    }
                  >
                    <Tip label={t("settings.backends.useForNewHint")}>
                      <Button size="sm" variant="quiet" onClick={() => props.conns.chooseNewConn(conn().id)}>
                        {t("settings.backends.useForNew")}
                      </Button>
                    </Tip>
                  </Show>
                )}
              </Show>
              {/* The supervisor starts what it does not already run, so one
                  action covers start and restart. While a login prompt is
                  parked the form below is the way forward — restarting would
                  only re-park. Armed reads as danger: the next press
                  interrupts a running session. */}
              <Show when={!parked()}>
                <Tip
                  label={
                    launchData()?.state === "running" && !restartArmed() ? t("settings.opencode.restartHint") : ""
                  }
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={launchData()?.state === "running" && restartArmed() ? "destructive" : "outline"}
                    disabled={runtimeBusy() || !inDesktopShell()}
                    onClick={() => (launchData()?.state === "running" ? armRestart() : void restartRuntime())}
                  >
                    {launchData()?.state === "running"
                      ? restartArmed()
                        ? t("settings.opencode.restartConfirm")
                        : t("settings.opencode.restart")
                      : t("settings.opencode.start")}
                  </Button>
                </Tip>
              </Show>
            </div>
          </Row>

          {/* The forked CLI gates every command on a domain login while it has
              no credentials saved; the answer goes down the parked child's
              stdin, so the form only exists while that prompt is up. */}
          <Show when={parked()}>
            <Row
              label={t("settings.opencode.login")}
              hint={t("settings.opencode.loginHint")}
              note={
                <Show when={launchData()?.state === "authFailed"}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {t("settings.opencode.loginFailed")}
                  </p>
                </Show>
              }
            >
              <div class="flex w-full flex-col items-stretch gap-2">
                <TextFieldInput
                  size="sm"
                  value={loginUser()}
                  onInput={(e) => setLoginUser(e.currentTarget.value)}
                  class="bg-background"
                  placeholder={t("settings.opencode.loginUser")}
                  aria-label={t("settings.opencode.loginUser")}
                  autocomplete="username"
                />
                <TextFieldInput
                  size="sm"
                  type="password"
                  value={loginPass()}
                  onInput={(e) => setLoginPass(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitLogin();
                  }}
                  class="bg-background"
                  placeholder={t("settings.opencode.loginPass")}
                  aria-label={t("settings.opencode.loginPass")}
                  autocomplete="current-password"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loginBusy() || !loginUser().trim() || !loginPass() || !inDesktopShell()}
                  onClick={() => void submitLogin()}
                >
                  {loginBusy() ? t("settings.opencode.loginBusy") : t("settings.opencode.loginSubmit")}
                </Button>
              </div>
            </Row>
          </Show>

          <Show when={!binaryTrouble()}>
            <Button
              type="button"
              variant="quiet"
              size="xs"
              class="my-1.5 -ml-2 gap-1.5"
              aria-expanded={details()}
              onClick={() => setDetails((open) => !open)}
            >
              <Icon name="chevron" class={`size-2.5 transition-transform ${details() ? "" : "-rotate-90"}`} />
              {t("settings.engine.details")}
              <span class="font-mono">{runtime()?.version ?? ""}</span>
            </Button>
          </Show>
          <Show when={showDetails()}>
            {/* Doctor's verdict sits next to the binary it belongs to: the path
                as a chip, then one quiet line with the version and when it was
                last verified. */}
            <Row
              label={t("settings.opencode.bin")}
              hint={`${t("settings.opencode.source")}: ${runtimeSource()}`}
              note={
                <>
                  <p class="mt-1.5 max-w-full">
                    <code
                      class="block max-w-full truncate rounded-sm bg-secondary/70 px-1.5 py-0.5 font-mono text-2xs text-foreground"
                      title={runtime()?.bin ?? ""}
                    >
                      {runtime()?.bin ?? (runtime() ? t("settings.opencode.binMissing") : "—")}
                    </code>
                  </p>
                  <Show when={runtime()}>
                    <p class="mt-1.5 text-2xs text-muted-foreground">
                      {t("settings.opencode.version")} <span class="font-mono">{runtime()?.version ?? "—"}</span>
                      <Show when={runtime()?.checked_at}>
                        {" · "}
                        {t("settings.opencode.checkedAt", { at: stamp(runtime()!.checked_at! * 1000) })}
                      </Show>
                    </p>
                  </Show>
                  <Show when={!inDesktopShell()}>
                    <p class="mt-1.5 flex items-center gap-1.5 text-2xs leading-4 text-muted-foreground">
                      {t("settings.opencode.desktopOnly")}
                    </p>
                  </Show>
                  <Show when={runtime()?.source === "env"}>
                    <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">{t("settings.opencode.envHint")}</p>
                  </Show>
                  <Show when={runtimeErr()}>
                    <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                      <Icon name="alert" class="size-3 shrink-0" />
                      {runtimeErr()}
                    </p>
                  </Show>
                  <Show when={runtime()?.error}>
                    <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                      <Icon name="alert" class="size-3 shrink-0" />
                      {runtimeErrorText(runtime()?.error)}
                    </p>
                  </Show>
                </>
              }
            >
              {/* Choosing a binary carries the weight; checking again and
                  clearing the override are upkeep, an icon with its name in a
                  tooltip. */}
              <div class="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={runtimeBusy() || !inDesktopShell()}
                  onClick={() => void pickRuntime()}
                >
                  {t("settings.opencode.chooseBin")}
                </Button>
                <Tip label={t("settings.opencode.check")}>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={t("settings.opencode.check")}
                    disabled={runtimeBusy() || !inDesktopShell()}
                    onClick={() => void checkRuntime()}
                  >
                    <Icon name="replay" class="size-3.5" />
                  </Button>
                </Tip>
                <Show when={runtime()?.source === "setting"}>
                  <Tip label={t("settings.opencode.clearBin")}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label={t("settings.opencode.clearBin")}
                      disabled={runtimeBusy() || !inDesktopShell()}
                      onClick={() => void clearRuntime()}
                    >
                      <Icon name="x" class="size-3.5" />
                    </Button>
                  </Tip>
                </Show>
              </div>
            </Row>
          </Show>
        </Show>
      </Card>
    </Group>
  );
}
