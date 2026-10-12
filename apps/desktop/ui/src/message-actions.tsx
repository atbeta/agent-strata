import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { Button } from "./components/ui/button";
import { t } from "./i18n";

/**
 * The small copy/edit/revert/fork row under a transcript message. The footer
 * keeps its h-7 box whether or not the buttons are currently visible, so a
 * message finishing or a pointer arriving never shifts the content above it.
 * `disabled` hides the controls while reserving that space — used while the
 * message is still streaming.
 */
export function MessageActions(props: {
  text: string;
  align: "start" | "end";
  onEdit?: () => void;
  onRevert?: () => void;
  onFork?: () => void;
  disabled?: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  /**
   * Each copy and each text change bumps this. A stale writeText resolving
   * late — or a timer scheduled by an older copy — sees a token that is no
   * longer current and must not touch the feedback for the new text.
   */
  let token = 0;
  const invalidate = () => {
    token++;
    clearTimeout(timer);
    setCopied(false);
  };
  onCleanup(() => {
    alive = false;
    invalidate();
  });
  createEffect(on(() => props.text, invalidate));

  const copy = async () => {
    const clip = navigator.clipboard;
    if (!clip?.writeText) return;
    const mine = ++token;
    clearTimeout(timer);
    setCopied(false);
    try {
      await clip.writeText(props.text);
    } catch {
      // Rejection — or a synchronous throw — leaves the copy label in place.
      return;
    }
    if (!alive || mine !== token) return;
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (alive && mine === token) setCopied(false);
    }, 2000);
  };

  const btn = "size-6 text-muted-foreground";
  return (
    <div
      class={`message-actions mt-1 flex h-7 items-center gap-0.5 ${
        props.align === "end" ? "justify-end" : "justify-start"
      }`}
    >
      <Show when={!props.disabled}>
        <Show when={props.text.trim()}>
          <Tip label={copied() ? t("message.copied") : t("message.copy")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              class={btn}
              aria-label={copied() ? t("message.copied") : t("message.copy")}
              onClick={copy}
            >
              <Icon name={copied() ? "check" : "copy"} class="size-3.5" />
            </Button>
          </Tip>
        </Show>
        <Show when={props.onEdit}>
          {(edit) => (
            <Tip label={t("message.edit")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class={btn}
                aria-label={t("message.edit")}
                onClick={() => edit()()}
              >
                <Icon name="pencil" class="size-3.5" />
              </Button>
            </Tip>
          )}
        </Show>
        <Show when={props.onRevert}>
          {(revert) => (
            <Tip label={t("message.revert")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class={btn}
                aria-label={t("message.revert")}
                onClick={() => revert()()}
              >
                <Icon name="undo" class="size-3.5" />
              </Button>
            </Tip>
          )}
        </Show>
        <Show when={props.onFork}>
          {(fork) => (
            <Tip label={t("message.fork")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class={btn}
                aria-label={t("message.fork")}
                onClick={() => fork()()}
              >
                <Icon name="branch" class="size-3.5" />
              </Button>
            </Tip>
          )}
        </Show>
      </Show>
    </div>
  );
}
