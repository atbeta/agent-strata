import { createEffect, createMemo, createSignal, For } from "solid-js";
import { Button } from "@/components/ui/button";
import { fieldVariants } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TextFieldInput } from "@/components/ui/text-field";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { LOCALE_TAG, locale, t } from "./i18n";
import {
  clockText,
  fromLocalInputValue,
  parseClock,
  toLocalInputValue,
  weekdayShortName,
} from "./schedule-format";

interface CalendarDay {
  date: Date;
  inMonth: boolean;
}

export function ScheduleDateTimeField(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [month, setMonth] = createSignal(startOfMonth(new Date()));
  const [datePart, setDatePart] = createSignal("");
  const [time, setTime] = createSignal("09:00");

  createEffect(() => {
    const value = props.value;
    const ms = fromLocalInputValue(value);
    if (ms === null) {
      if (!value) {
        setMonth(startOfMonth(new Date()));
        setDatePart("");
        setTime("09:00");
      }
      return;
    }
    const date = new Date(ms);
    setMonth(startOfMonth(date));
    setDatePart(toLocalInputValue(ms).slice(0, 10));
    setTime(clockText(date.getHours(), date.getMinutes()));
  });

  const days = createMemo(() => calendarDays(month()));
  const monthLabel = () =>
    new Intl.DateTimeFormat(LOCALE_TAG[locale()], {
      year: "numeric",
      month: "long",
    }).format(month());
  const selected = () => fromLocalInputValue(props.value);
  const triggerText = () => {
    const ms = selected();
    if (ms === null) return props.value ? props.value.replace("T", " ") : t("schedule.panel.dateTimePick");
    return new Intl.DateTimeFormat(LOCALE_TAG[locale()], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  };

  const chooseDay = (date: Date) => {
    const clock = parseClock(time()) ?? { hour: 9, minute: 0 };
    setTime(clockText(clock.hour, clock.minute));
    const next = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      clock.hour,
      clock.minute,
    );
    props.onChange(toLocalInputValue(next.getTime()));
  };

  const changeTime = (next: string) => {
    setTime(next);
    if (datePart()) props.onChange(`${datePart()}T${next}`);
  };

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={6}>
      <PopoverTrigger
        class={cn(
          fieldVariants({ size: "sm" }),
          "flex items-center gap-2 bg-transparent text-left font-normal",
        )}
        aria-label={t("schedule.panel.onceAtLabel")}
      >
        <Icon name="calendar" class="size-3.5 shrink-0 text-muted-foreground" />
        <span class={cn("min-w-0 flex-1 truncate", !props.value && "text-muted-foreground")}>
          {triggerText()}
        </span>
        <Icon name="chevron" class="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent class="w-72 p-3">
        <div class="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            aria-label={t("schedule.panel.previousMonth")}
            onClick={() => setMonth(new Date(month().getFullYear(), month().getMonth() - 1, 1))}
          >
            <Icon name="arrow-left" class="size-3.5" />
          </Button>
          <p class="min-w-0 flex-1 truncate text-center text-sm font-medium" aria-live="polite">
            {monthLabel()}
          </p>
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            aria-label={t("schedule.panel.nextMonth")}
            onClick={() => setMonth(new Date(month().getFullYear(), month().getMonth() + 1, 1))}
          >
            <Icon name="chevron-right" class="size-3.5" />
          </Button>
        </div>
        <div class="mt-2 grid grid-cols-7 gap-0.5 text-center text-2xs text-muted-foreground">
          <For each={[0, 1, 2, 3, 4, 5, 6]}>
            {(day) => <span class="truncate py-1">{weekdayShortName(day)}</span>}
          </For>
        </div>
        <div class="grid grid-cols-7 gap-0.5">
          <For each={days()}>
            {(day) => (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class={cn(
                  "h-8 w-full p-0 text-xs font-normal text-foreground hover:bg-secondary",
                  !day.inMonth && "text-muted-foreground/50",
                  sameDay(day.date, new Date()) && "ring-1 ring-border",
                  selected() !== null && sameDay(day.date, new Date(selected()!)) &&
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                aria-label={day.date.toLocaleDateString(LOCALE_TAG[locale()])}
                aria-pressed={selected() !== null && sameDay(day.date, new Date(selected()!))}
                onClick={() => chooseDay(day.date)}
              >
                {day.date.getDate()}
              </Button>
            )}
          </For>
        </div>
        <div class="mt-3 border-t border-border pt-3">
          <label class="mb-1.5 block text-2xs text-muted-foreground" for="schedule-at-time">
            {t("schedule.panel.time")}
          </label>
          <TextFieldInput
            id="schedule-at-time"
            size="sm"
            value={time()}
            inputMode="numeric"
            spellcheck={false}
            placeholder="09:30"
            aria-invalid={!parseClock(time())}
            onInput={(event) => changeTime(event.currentTarget.value)}
          />
        </div>
        <div class="mt-3 flex items-center justify-between">
          <Button type="button" size="xs" variant="quiet" onClick={() => chooseDay(new Date())}>
            {t("schedule.panel.today")}
          </Button>
          <Button type="button" size="xs" variant="secondary" onClick={() => setOpen(false)}>
            {t("schedule.panel.done")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function calendarDays(month: Date): CalendarDay[] {
  const first = startOfMonth(month);
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return { date, inMonth: date.getMonth() === first.getMonth() };
  });
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}
