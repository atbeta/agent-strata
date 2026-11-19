import { createMemo, createSignal, For, Show } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fieldVariants } from "@/components/ui/field";
import { TextFieldInput } from "@/components/ui/text-field";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import type { ScheduleCandidate } from "./api";
import { t } from "./i18n";
import { filterScheduleCandidates } from "./schedule-candidates";

const VISIBLE_LIMIT = 30;

export function ScheduleSessionPicker(props: {
  value: string;
  options: ScheduleCandidate[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => filterScheduleCandidates(props.options, query()));
  const visible = () => matches().slice(0, VISIBLE_LIMIT);
  const current = () => props.options.find((option) => option.session_id === props.value);
  const currentLabel = () => current()?.title || props.value || t("schedule.panel.sessionPick");

  return (
    <DropdownMenu
      open={open()}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
      gutter={6}
    >
      <DropdownMenuTrigger
        class={cn(
          fieldVariants({ size: "sm" }),
          "flex items-center justify-between gap-2 bg-transparent text-left font-normal",
        )}
        aria-label={t("schedule.panel.sessionId")}
      >
        <span class={cn("min-w-0 flex-1 truncate", !props.value && "text-muted-foreground")}>
          {currentLabel()}
        </span>
        <Icon name="chevron" class="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="flex max-h-96 w-[var(--kb-popper-anchor-width)] min-w-64 flex-col p-0">
        <div class="shrink-0 border-b border-border p-2">
          <TextFieldInput
            type="search"
            size="sm"
            value={query()}
            placeholder={t("schedule.panel.sessionSearch")}
            aria-label={t("schedule.panel.sessionSearch")}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                return;
              }
              event.stopPropagation();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-1">
          <For each={visible()}>
            {(option) => {
              const label = () => option.title || option.session_id;
              return (
                <DropdownMenuItem
                  onSelect={() => props.onChange(option.session_id)}
                  class="items-start justify-between gap-3 py-2"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs text-foreground" title={label()}>
                      {label()}
                    </span>
                    <Show when={option.title && option.title !== option.session_id}>
                      <span class="mt-0.5 block truncate font-mono text-2xs text-muted-foreground">
                        {option.session_id}
                      </span>
                    </Show>
                  </span>
                  <Show when={option.session_id === props.value}>
                    <Icon name="check" class="mt-0.5 size-3.5 shrink-0 text-foreground" />
                  </Show>
                </DropdownMenuItem>
              );
            }}
          </For>
          <Show when={matches().length === 0}>
            <p class="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("schedule.panel.sessionNoMatch")}
            </p>
          </Show>
        </div>
        <Show when={matches().length > VISIBLE_LIMIT}>
          <p class="shrink-0 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
            {t("schedule.panel.sessionMore")}
          </p>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
