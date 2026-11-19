import { Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { Tip } from "@/tip";
import { tn } from "./i18n";

export interface ScheduleSummary {
  count: () => number;
  names: () => string[];
  next: () => string;
  open: () => void;
  active?: () => boolean;
}

export function SchedulePill(props: ScheduleSummary) {
  const countText = () => tn("composer.schedules", props.count());
  return (
    <Show when={props.count() > 0}>
      <Tip
        label={
          [...props.names(), props.next()].filter(Boolean).join("\n") || countText()
        }
      >
        <Button
          type="button"
          variant="outline"
          size="xs"
          class={`h-6 max-w-full gap-1.5 rounded-full px-2.5 text-2xs font-normal ${
            props.active?.()
              ? "border-input bg-secondary text-foreground"
              : "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
          aria-label={`${countText()}${props.next() ? ` · ${props.next()}` : ""}`}
          onClick={props.open}
        >
          <Icon name="clock" class="size-3.5 shrink-0" />
          <span class="shrink-0">{countText()}</span>
          <Show when={props.next()}>
            <span class="text-faint-foreground">·</span>
            <span class="max-w-40 truncate">{props.next()}</span>
          </Show>
        </Button>
      </Tip>
    </Show>
  );
}
