import { For, Show } from "solid-js";
import { RowButton } from "@/components/ui/row-button";
import { Icon, type Name } from "./icons";
import { t } from "./i18n";

export type RailLauncherItem = {
  id: string;
  label: string;
  icon: Name;
  count?: number;
  running?: number;
};

function LauncherGroup(props: {
  title: string;
  items: RailLauncherItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <Show when={props.items.length > 0}>
      <section>
        <h2 class="px-3 pb-1.5 pt-2 text-2xs text-muted-foreground">{props.title}</h2>
        <ul class="space-y-0.5">
          <For each={props.items}>
            {(item) => (
              <li>
                <RowButton
                  class="min-h-10 items-center gap-2.5 px-3 py-1.5"
                  onClick={() => props.onSelect(item.id)}
                >
                  <span class="grid size-6 shrink-0 place-items-center rounded-md bg-secondary/60 text-muted-foreground">
                    <Icon name={item.icon} class="size-4" />
                  </span>
                  <span class="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                  <Show when={item.running !== undefined && item.running > 0}>
                    <span class="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                      <span class="size-1.5 rounded-full bg-status-active" />
                      {item.running} {t("dev.running")}
                    </span>
                  </Show>
                  <Show when={item.count !== undefined && item.count > 0}>
                    <span class="shrink-0 text-2xs text-muted-foreground tabular-nums">{item.count}</span>
                  </Show>
                  <Icon name="chevron-right" class="size-3.5 shrink-0 text-faint-foreground" />
                </RowButton>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

export function RailLauncher(props: {
  builtin: RailLauncherItem[];
  plugins: RailLauncherItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
      <LauncherGroup title={t("panel.builtin")} items={props.builtin} onSelect={props.onSelect} />
      <div class="pt-2">
        <LauncherGroup title={t("panel.plugins")} items={props.plugins} onSelect={props.onSelect} />
      </div>
    </div>
  );
}
