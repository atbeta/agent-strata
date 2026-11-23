import { Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { Tip } from "@/tip";
import { tn } from "./i18n";

export interface TerminalSummary {
  count: () => number;
  details: () => string[];
  open: () => void;
  active?: () => boolean;
}

export function TerminalPill(props: TerminalSummary) {
  const countText = () => tn("composer.terminals", props.count());
  return (
    <Show when={props.count() > 0}>
      <Tip label={props.details().join("\n") || countText()}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          class={`h-6 max-w-full gap-1.5 rounded-full px-2.5 text-2xs font-normal ${
            props.active?.()
              ? "border-input bg-secondary text-foreground"
              : "border-border bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
          aria-label={countText()}
          onClick={props.open}
        >
          <Icon name="terminal" class="size-3.5 shrink-0" />
          <span class="shrink-0">{countText()}</span>
        </Button>
      </Tip>
    </Show>
  );
}
