import { Show, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { t } from "./i18n";

/**
 * The composer's footer row: attachments and session context on the left, the
 * model and its effort on the right, then send/stop/queue. Pickers arrive as
 * slot functions rather than elements because agent and effort render twice —
 * inline on wide columns and inside the compact popover the narrow one gets —
 * and a single DOM node cannot live in both places.
 */
export function ComposerToolbar(props: {
  context: () => JSX.Element;
  agent?: () => JSX.Element;
  model?: () => JSX.Element;
  effort?: () => JSX.Element;
  onAttach?: () => void;
  generating: boolean;
  stopping: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const gear = () => props.agent !== undefined || props.effort !== undefined;
  return (
    <div class="composer-toolbar flex items-center gap-2 px-3 pb-2.5">
      <Show when={props.onAttach}>
        {(attach) => (
          <Tip label={t("composer.attach")}>
            <Button
              type="button"
              size="icon-sm"
              variant="icon"
              class="shrink-0 rounded-full"
              aria-label={t("composer.attach")}
              onClick={() => attach()()}
            >
              <Icon name="plus" class="size-4" />
            </Button>
          </Tip>
        )}
      </Show>
      {props.context()}
      <span class="composer-wide-slot">{props.agent?.()}</span>
      <div class="ml-auto flex min-w-0 items-center gap-1">
        <span class="min-w-0">{props.model?.()}</span>
        <span class="composer-wide-slot">{props.effort?.()}</span>
        <Show when={gear()}>
          <span class="composer-compact-slot">
            <Popover gutter={6} placement="top-end">
              <Tip label={t("composer.more")}>
                <PopoverTrigger
                  class="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  aria-label={t("composer.more")}
                >
                  <Icon name="gear" class="size-4" />
                </PopoverTrigger>
              </Tip>
              <PopoverContent class="w-52 p-2">
                <Show when={props.agent}>
                  <p class="px-1 pb-0.5 text-2xs text-muted-foreground">{t("picker.agent")}</p>
                  {props.agent?.()}
                </Show>
                <Show when={props.effort}>
                  <p class="mt-1 px-1 pb-0.5 text-2xs text-muted-foreground">{t("picker.effort")}</p>
                  {props.effort?.()}
                </Show>
              </PopoverContent>
            </Popover>
          </span>
        </Show>
        <Show when={props.generating && props.canSend}>
          <Tip label={t("composer.queue.tip")}>
            <Button
              type="button"
              size="sm"
              variant="icon"
              class="composer-queue shrink-0 gap-1 rounded-full px-2 text-xs"
              aria-label={t("composer.queue")}
              onClick={() => props.onSend()}
            >
              <Icon name="list" class="size-3.5" />
              <span class="composer-queue-label">{t("composer.queue")}</span>
            </Button>
          </Tip>
        </Show>
        <Show when={props.generating}>
          <Tip label={props.stopping ? t("composer.stopping") : t("composer.stop")}>
            <Button
              type="button"
              size="icon-sm"
              variant="icon"
              class="shrink-0 rounded-full bg-foreground text-background transition-opacity hover:bg-foreground hover:text-background hover:opacity-80 motion-safe:active:scale-95"
              disabled={props.stopping}
              aria-label={props.stopping ? t("composer.stopping_aria") : t("composer.stop")}
              onClick={() => props.onStop()}
            >
              <span class="h-2.5 w-2.5 rounded-[2px] bg-background" />
            </Button>
          </Tip>
        </Show>
        <Show when={!props.generating}>
          <Tip label={props.canSend ? t("composer.send") : t("composer.type")}>
            <Button
              type="button"
              size="icon-sm"
              class="shrink-0 rounded-full transition-opacity motion-safe:active:scale-95"
              disabled={!props.canSend}
              aria-label={props.canSend ? t("composer.send") : t("composer.type")}
              onClick={() => props.onSend()}
            >
              <svg
                viewBox="0 0 16 16"
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M8 12.5v-9M3.8 7.3 8 3l4.2 4.3" />
              </svg>
            </Button>
          </Tip>
        </Show>
      </div>
    </div>
  );
}
