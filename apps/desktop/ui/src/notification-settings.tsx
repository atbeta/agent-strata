import { createResource, createSignal, Show } from "solid-js";
import { Switch } from "@/components/ui/switch";
import {
  disableNotify,
  enableNotify,
  readNotify,
  type NotifyKind,
} from "./notify";
import { readThinkingOpen, saveThinkingOpen } from "./thinking";
import { readConfirmQuit, saveConfirmQuit } from "./quit-confirm";
import { inDesktopShell } from "./shell";
import { fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Card, Group, Row } from "./settings-blocks";
import { SoundSettings } from "./sound-settings";

export function NotificationSettings() {
  const [thinkingOpen, setThinkingOpen] = createSignal(readThinkingOpen());
  // The shell's file is the truth here, not the page: the toggle reads it back
  // rather than trusting a copy the webview keeps.
  const [confirmQuit, { mutate: setConfirmQuit }] = createResource(readConfirmQuit);
  const [notifyDone, setNotifyDone] = createSignal(readNotify("done"));
  const [notifyQuestion, setNotifyQuestion] = createSignal(readNotify("question"));
  const [notifyErr, setNotifyErr] = fadeSignal<{ kind: NotifyKind; text: string } | undefined>(undefined);

  const toggleNotify = async (kind: NotifyKind) => {
    const on = kind === "done" ? notifyDone() : notifyQuestion();
    const setOn = kind === "done" ? setNotifyDone : setNotifyQuestion;
    if (on) {
      disableNotify(kind);
      setOn(false);
      setNotifyErr(undefined);
      return;
    }
    const ok = await enableNotify(kind);
    setOn(readNotify(kind) && ok);
    setNotifyErr(ok ? undefined : { kind, text: t("settings.notify.blocked") });
    if (!ok) disableNotify(kind);
  };

  const notifyRow = (kind: NotifyKind, on: () => boolean) => (
    <Row
      label={t(`settings.notify.${kind}.title`)}
      hint={t(`settings.notify.${kind}.hint`)}
      note={
        <Show when={notifyErr()?.kind === kind}>
          <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
            <Icon name="alert" class="size-3 shrink-0" />
            {notifyErr()?.text}
          </p>
        </Show>
      }
    >
      <Switch
        checked={on()}
        aria-label={t(`settings.notify.${kind}.title`)}
        onChange={(next) => {
          if (next !== on()) void toggleNotify(kind);
        }}
      />
    </Row>
  );

  return (
    <>
      <Group label={t("settings.session.group")}>
        <Card>
          <Row label={t("settings.thinking.title")} hint={t("settings.thinking.hint")}>
            <Switch
              checked={thinkingOpen()}
              aria-label={t("settings.thinking.title")}
              onChange={(next) => {
                setThinkingOpen(next);
                saveThinkingOpen(next);
              }}
            />
          </Row>
          {notifyRow("done", notifyDone)}
          {notifyRow("question", notifyQuestion)}
          {/* Quitting is a shell affair — a browser tab has no close request
              to intercept, so the row itself is desktop-only. */}
          <Show when={inDesktopShell()}>
            <Row label={t("settings.quitConfirm.title")} hint={t("settings.quitConfirm.hint")}>
              <Switch
                checked={confirmQuit() ?? false}
                aria-label={t("settings.quitConfirm.title")}
                onChange={(next) => {
                  setConfirmQuit(next);
                  void saveConfirmQuit(next);
                }}
              />
            </Row>
          </Show>
        </Card>
      </Group>
      <SoundSettings />
    </>
  );
}
