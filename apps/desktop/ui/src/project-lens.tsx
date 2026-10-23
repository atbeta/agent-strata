import { For, Show } from "solid-js";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { cn } from "./lib/utils";
import { backendLabel } from "./api";
import type { GroupBy, PeriodLens, StatusLens } from "./project-view";
import type { SessionListCtl } from "./use-session-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TextField, TextFieldInput } from "@/components/ui/text-field";

/** One choice in a category. */
type Option = { id: string; label: string };

const STATUS_LABEL: Record<StatusLens, string> = {
  all: "sidebar.project.filter.all",
  busy: "sidebar.project.filter.status.busy",
  waiting: "sidebar.project.filter.status.waiting",
  idle: "sidebar.project.filter.status.idle",
};

const PERIOD_LABEL: Record<PeriodLens, string> = {
  all: "sidebar.project.filter.all",
  today: "sidebar.project.filter.period.today",
  week: "sidebar.project.filter.period.week",
  month: "sidebar.project.filter.period.month",
};

/**
 * A category row: what it is on the left, what it is set to on the right, and
 * the values behind the arrow.
 *
 * The value is on the row because a reader who opens this menu wants to know
 * what is set without opening anything — the row is the answer, the submenu is
 * how the answer is changed.
 */
function LensRow(props: {
  label: string;
  value: string;
  current: string;
  options: Option[];
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger class="gap-2">
        <span class="flex-1 truncate">{props.label}</span>
        <span class="truncate text-2xs text-muted-foreground">{props.value}</span>
        <Icon name="chevron-right" class="size-3 shrink-0 text-muted-foreground/50" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent class="w-[172px]">
        <For each={props.options}>
          {(option) => (
            <DropdownMenuItem
              // The menu stays open: a reader who came to set the time is
              // often setting the status too, and reopening the menu for each
              // one turns two settings into four clicks.
              closeOnSelect={false}
              onSelect={() => props.onSelect(option.id)}
            >
              <span class="flex-1 truncate">{option.label}</span>
              <Show when={option.id === props.current}>
                <Icon name="check" class="size-3.5 text-foreground" />
              </Show>
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The lens on the project section, and the button that says it is on.
 *
 * The button sits on the "项目" line, beside the one that opens a directory,
 * and it opens to the right rather than down: a lens that covers the list it
 * narrows is a lens the reader cannot watch working.
 *
 * The menu is a set of categories rather than a set of checkboxes — the same
 * shape a mixer has. Each row names one axis the list can be cut along and
 * says what it is set to; the values live one step deeper, so a reader who
 * only wants to see that the time is set to "today" reads it off the row
 * without hunting for it.
 */
export function ProjectLensMenu(props: { list: SessionListCtl }) {
  const lens = () => props.list.lens();

  const groupOptions = (): Option[] => [
    { id: "project", label: t("sidebar.project.filter.byProject") },
    { id: "day", label: t("sidebar.project.filter.byDay") },
  ];

  const typeOptions = (): Option[] => [
    { id: "", label: t("sidebar.project.filter.all") },
    ...props.list.types().map((backend) => ({ id: backend, label: backendLabel(backend) })),
  ];

  const statusOptions = (): Option[] => [
    { id: "all", label: t("sidebar.project.filter.all") },
    { id: "busy", label: t("sidebar.project.filter.status.busy") },
    { id: "waiting", label: t("sidebar.project.filter.status.waiting") },
    { id: "idle", label: t("sidebar.project.filter.status.idle") },
  ];

  const periodOptions = (): Option[] => [
    { id: "all", label: t("sidebar.project.filter.all") },
    { id: "today", label: t("sidebar.project.filter.period.today") },
    { id: "week", label: t("sidebar.project.filter.period.week") },
    { id: "month", label: t("sidebar.project.filter.period.month") },
  ];

  const emptyOptions = (): Option[] => [
    { id: "show", label: t("sidebar.project.filter.show") },
    { id: "hide", label: t("sidebar.project.filter.hide") },
  ];

  const on = () => props.list.lensActive();

  return (
    <DropdownMenu placement="right-start" gutter={8}>
      <Tip label={on() ? t("sidebar.project.filter.on") : t("sidebar.project.filter")}>
        <DropdownMenuTrigger
          class={cn(
            "grid h-5 place-items-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            // A search, a status, a period or a backend takes sessions off
            // the list, and the button has to keep saying so after the menu
            // closes. Hiding empty projects and the way the list is grouped
            // are how the reader keeps the sidebar; they stay written on
            // their own rows and do not light this chip.
            on()
              ? "grid-flow-col gap-0.5 bg-primary/15 px-1 text-primary hover:bg-primary/20 hover:text-primary"
              : "size-5",
          )}
          aria-label={t("sidebar.project.filter")}
          aria-pressed={on()}
        >
          <Show when={on()}>
            <span class="min-w-2 text-center text-2xs font-medium tabular-nums leading-none">
              {props.list.lensCount()}
            </span>
          </Show>
          <Icon name="sliders" class="size-3.5" />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent class="w-[228px]">
        <form
          class="px-2 py-1.5"
          onSubmit={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <TextField>
            <TextFieldInput
              bare
              size="sm"
              value={lens().query}
              onChange={(e) => props.list.setQuery(e.currentTarget.value)}
              class="bg-background text-2xs"
              placeholder={t("sidebar.project.filter.placeholder")}
              aria-label={t("sidebar.project.filter.label")}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </TextField>
        </form>
        <DropdownMenuSeparator />
        <LensRow
          label={t("sidebar.project.filter.groupBy")}
          value={
            lens().groupBy === "day"
              ? t("sidebar.project.filter.byDay")
              : t("sidebar.project.filter.byProject")
          }
          current={lens().groupBy}
          options={groupOptions()}
          onSelect={(id) => props.list.setGroupBy(id as GroupBy)}
        />
        <LensRow
          label={t("sidebar.project.filter.type")}
          value={lens().type ? backendLabel(lens().type) : t("sidebar.project.filter.all")}
          current={lens().type}
          options={typeOptions()}
          onSelect={(id) => props.list.setType(id)}
        />
        <LensRow
          label={t("sidebar.project.filter.status")}
          value={t(STATUS_LABEL[lens().status] as Parameters<typeof t>[0])}
          current={lens().status}
          options={statusOptions()}
          onSelect={(id) => props.list.setStatus(id as StatusLens)}
        />
        <LensRow
          label={t("sidebar.project.filter.period")}
          value={t(PERIOD_LABEL[lens().period] as Parameters<typeof t>[0])}
          current={lens().period}
          options={periodOptions()}
          onSelect={(id) => props.list.setPeriod(id as PeriodLens)}
        />
        <LensRow
          label={t("sidebar.project.filter.emptyProjects")}
          value={lens().hideEmpty ? t("sidebar.project.filter.hide") : t("sidebar.project.filter.show")}
          current={lens().hideEmpty ? "hide" : "show"}
          options={emptyOptions()}
          onSelect={(id) => props.list.setHideEmpty(id === "hide")}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => props.list.clearLens()}>
          {t("sidebar.project.filter.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
