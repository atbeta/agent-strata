import { createResource, createSignal, For, Show, type JSX } from "solid-js";
import { fetchDailyUsage, fmtUsd, realWorkspace, type SessionRow } from "./api";
import { sessionStatus } from "./session-status";
import { SessionStatusMark } from "@/components/ui/session-status";
import {
  cacheEfficiency,
  fleetModels,
  fleetProjects,
  fleetRecent,
  fleetStatus,
  fleetTotals,
  fleetTrend,
  fmtShare,
  PERIODS,
  periodStart,
  projectName,
  relTime,
  sessionPeriodTotals,
  shareOf,
  tokenTotal,
  type FleetTotals,
  type Period,
  type TokenKey,
  type TrendPoint,
} from "./fleet";
import { compactNum, num, t, tn } from "./i18n";
import { displayTitle } from "./session-title";
import { Tip } from "./tip";
import { Icon } from "./icons";
import { RowButton } from "@/components/ui/row-button";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { cn } from "@/lib/utils";

/**
 * Chart marks, not status.
 *
 * The `--chart-*` slots exist so a bar can be a bar. `status-active` green and
 * `status-cancelled` amber are the same hues, but a reader who has seen them in
 * the sidebar reads them as a running session and a cancelled one — so a spend
 * column in those colours would report a status this page never observed.
 */
const TOKEN_TONE: Record<TokenKey, string> = {
  input: "bg-chart-1",
  cacheRead: "bg-chart-3",
  cacheWrite: "bg-chart-4",
  output: "bg-chart-2",
  reasoning: "bg-chart-5",
};

/** `satisfies` rather than an annotation: the labels have to stay literal, or
 *  `t()` widens them to `string` and the key check stops being a check. */
const TOKEN_LABEL = {
  input: "fleet.tokens.input",
  cacheRead: "fleet.tokens.cacheRead",
  cacheWrite: "fleet.tokens.cacheWrite",
  output: "fleet.tokens.output",
  reasoning: "fleet.tokens.reasoning",
} as const satisfies Record<TokenKey, string>;

/** The order a breakdown reads in: prompt in, cache served, model wrote back. */
const TOKEN_ORDER: TokenKey[] = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];

const TREND_DAYS = 14;
const STATUS_SHOWN = 5;
const RECENT_SHOWN = 10;

/**
 * The landing pane.
 *
 * The sidebar is already the list of sessions, so this does not repeat "pick
 * one" as its only job. It answers what the list cannot: whether anything is
 * waiting on a person, what the current scope has cost, and which directories
 * and models the spend sits in.
 *
 * Status leads because it is the only thing on the page that asks for an
 * action. Usage comes second, and its windows are what actually happened
 * inside them — the day's usage buckets, never a session's lifetime
 * re-labelled as "today". While the buckets are in flight the figures say "—"
 * rather than guess, and the lists fall back to what the session rows alone
 * can say.
 */
export function FleetView(props: {
  sessions: SessionRow[];
  now: number;
  onOpen: (id: string) => void;
  onOpenProject: (directory: string) => void;
}) {
  const [period, setPeriod] = createSignal<Period>("total");
  const [rank, setRank] = createSignal<"projects" | "models">("projects");
  const [allRecent, setAllRecent] = createSignal(false);
  // The service buckets by the caller's zone, so the UI's day keys agree
  // with the service's day keys by construction.
  const [daily] = createResource(() =>
    fetchDailyUsage(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const buckets = () => (daily.state === "ready" ? daily() : undefined);

  const totalsFor = (key: Period) =>
    buckets() ? fleetTotals(props.sessions, buckets()!, key, props.now) : undefined;

  /** All four windows at once: the tabs show each one's own figures. */
  const windows = () => PERIODS.map((key) => ({ key, totals: totalsFor(key) }));
  const totals = () => totalsFor(period());
  const status = () => fleetStatus(props.sessions);
  const recent = () => fleetRecent(props.sessions, buckets() ?? [], period(), props.now);
  const perSession = () => sessionPeriodTotals(props.sessions, buckets() ?? [], period(), props.now);
  const projects = () => fleetProjects(props.sessions, buckets() ?? [], period(), props.now);
  const models = () => fleetModels(props.sessions, buckets() ?? [], period(), props.now);
  const trend = () => fleetTrend(props.sessions, buckets() ?? [], props.now, TREND_DAYS);

  const shownRecent = () => (allRecent() ? recent() : recent().slice(0, RECENT_SHOWN));

  // The share bar divides one measure against itself, so it has to be the same
  // measure the row shows: tokens, not the dollar figure that now sits below it.
  const projectTokens = () => projects().reduce((sum, p) => sum + p.tokens, 0);
  const projectWhole = () =>
    projectTokens() > 0 ? projectTokens() : projects().reduce((sum, p) => sum + p.sessions, 0);
  const modelWhole = () => models().reduce((sum, m) => sum + m.tokens, 0);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-4">
          <StatusCard
            waiting={status().waiting}
            running={status().running}
            now={props.now}
            onOpen={props.onOpen}
          />

          <section>
            <SectionHead label={t("fleet.usage")} />
            <div class="mt-2.5 flex flex-col gap-3">
              <PeriodTabs windows={windows()} value={period()} onChange={setPeriod} />
              <UsageCard
                totals={totals()}
                points={trend()}
                since={periodStart(period(), props.now)}
                all={period() === "total"}
              />
            </div>
          </section>

          <Show
            when={props.sessions.length > 0}
            fallback={
              <div class="flex flex-1 items-center justify-center py-10">
                <EmptyState icon="list" title={t("fleet.overview.empty")} />
              </div>
            }
          >
            <div class="grid grid-cols-1 items-start gap-4 pb-2 md:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
              <section class="min-w-0">
                <SectionHead label={t("fleet.overview.recent")} count={recent().length} />
                <div class="mt-2.5 overflow-hidden rounded-lg border border-border bg-card">
                  <Show
                    when={recent().length > 0}
                    fallback={<p class="px-4 py-6 text-2xs text-muted-foreground">{t("fleet.overview.emptyPeriod")}</p>}
                  >
                    <ul class="divide-y divide-border">
                      <For each={shownRecent()}>
                        {(s) => {
                          const used = () => perSession().get(s.summary.session_id);
                          const modelId = () => modelIdPart(used()?.model ?? null);
                          return (
                            <li>
                              <RowButton
                                class="items-start gap-3 rounded-none px-4 py-2.5"
                                onClick={() => props.onOpen(s.summary.session_id)}
                              >
                                <SessionStatusMark status={sessionStatus(s)} class="mt-1" />
                                <span class="min-w-0 flex-1">
                                  <span class="block truncate text-sm text-foreground">
                                    {displayTitle(s.title ?? s.summary.title) ?? t("common.untitled")}
                                  </span>
                                  <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                                    {projectLabel(s)}
                                    <Show when={modelId()}>
                                      <span class="text-muted-foreground/50">{" · "}</span>
                                      <span class="font-mono">{modelId()}</span>
                                    </Show>
                                  </span>
                                </span>
                                <span class="shrink-0 text-right">
                                  <Show when={(used()?.tokens ?? 0) > 0}>
                                    <Tip label={num(used()!.tokens)}>
                                      <span
                                        class="block text-2xs tabular-nums text-muted-foreground"
                                        title={`${t("fleet.overview.estCost")} ${fmtUsd(used()!.cost)}`}
                                      >
                                        {compactNum(used()!.tokens)}
                                      </span>
                                    </Tip>
                                  </Show>
                                  <span class="mt-0.5 block text-2xs text-muted-foreground">
                                    {relTime(s.summary.last_ts, props.now)}
                                  </span>
                                </span>
                              </RowButton>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </Show>
                </div>
                <Show when={!allRecent() && recent().length > RECENT_SHOWN}>
                  <Button
                    variant="quiet"
                    class="mt-1 w-full"
                    onClick={() => setAllRecent(true)}
                  >
                    {t("fleet.recent.all", { n: num(recent().length) })}
                  </Button>
                </Show>
              </section>

              <section class="min-w-0">
                <div class="flex items-baseline justify-between gap-3">
                  <SectionHead label={t("fleet.rank")} />
                  <MiniTabs
                    kind="tabs"
                    value={rank()}
                    onChange={(id) => setRank(id as "projects" | "models")}
                    options={[
                      { id: "projects", label: t("fleet.rank.projects") },
                      { id: "models", label: t("fleet.rank.models") },
                    ]}
                  />
                </div>
                <div class="mt-2.5 overflow-hidden rounded-lg border border-border bg-card">
                  <Show
                    when={rank() === "projects"}
                    fallback={
                      <Show
                        when={models().length > 0}
                        fallback={<p class="px-4 py-6 text-2xs text-muted-foreground">{t("fleet.overview.emptyPeriod")}</p>}
                      >
                        <ul class="divide-y divide-border">
                          <For each={models()}>
                            {(m) => (
                              <li class="px-4 py-3">
                                <ModelBody model={m} whole={modelWhole()} />
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    }
                  >
                    <Show
                      when={projects().length > 0}
                      fallback={<p class="px-4 py-6 text-2xs text-muted-foreground">{t("fleet.overview.emptyPeriod")}</p>}
                    >
                      <ul class="divide-y divide-border">
                        <For each={projects()}>
                          {(p) => (
                            <li>
                              <ProjectRow
                                project={p}
                                part={projectTokens() > 0 ? p.tokens : p.sessions}
                                whole={projectWhole()}
                                onOpen={p.workspace ? () => props.onOpenProject(p.workspace!) : undefined}
                              />
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </div>
              </section>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function projectLabel(s: SessionRow): string {
  const ws = realWorkspace(s.workspace ?? s.summary.workspace);
  return ws ? projectName(ws) : t("sidebar.project.none");
}

/** `providerID/modelID` → the modelID half; anything without a slash is all ID. */
function modelIdPart(model: string | null): string | null {
  if (!model) return null;
  const i = model.indexOf("/");
  return i < 0 ? model : model.slice(i + 1);
}

/** `providerID/modelID` → the providerID half, or null when there is none. */
function providerIdPart(model: string | null): string | null {
  if (!model) return null;
  const i = model.indexOf("/");
  return i < 0 ? null : model.slice(0, i);
}

function SectionHead(props: { label: string; count?: number }) {
  return (
    <h2 class="text-xs font-medium text-muted-foreground">
      {props.label}
      <Show when={props.count !== undefined}>
        <span class="ml-1.5 tabular-nums text-muted-foreground/60">{props.count}</span>
      </Show>
    </h2>
  );
}

/**
 * The sessions that are waiting on somebody or still working, at the top of
 * the page — the one thing here that asks for an action earns the first slot.
 * Waiting outranks running because a session stopped at a permission prompt
 * is going nowhere until a person answers it.
 *
 * When neither group has anything the section drops to a quiet line: "all
 * clear" is a fact worth one line, not a card.
 */
function StatusCard(props: {
  waiting: SessionRow[];
  running: SessionRow[];
  now: number;
  onOpen: (id: string) => void;
}) {
  return (
    <Show
      when={props.waiting.length + props.running.length > 0}
      fallback={
        <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="check" class="size-3.5 text-status-active" />
          {t("fleet.status.clear")}
        </p>
      }
    >
      <section class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        <StatusGroup
          label={t("fleet.status.waiting")}
          rows={props.waiting}
          now={props.now}
          accent
          onOpen={props.onOpen}
        />
        <StatusGroup label={t("fleet.status.running")} rows={props.running} now={props.now} onOpen={props.onOpen} />
      </section>
    </Show>
  );
}

function StatusGroup(props: {
  label: string;
  rows: SessionRow[];
  now: number;
  accent?: boolean;
  onOpen: (id: string) => void;
}) {
  const shown = () => props.rows.slice(0, STATUS_SHOWN);
  const rest = () => props.rows.length - shown().length;
  return (
    <Show when={props.rows.length > 0}>
      <div>
        <div
          class={cn(
            "px-4 pb-1 pt-2.5 text-2xs font-medium",
            props.accent ? "text-event-permission" : "text-muted-foreground",
          )}
        >
          {props.label}
          <span class="ml-1.5 tabular-nums text-muted-foreground/60">{props.rows.length}</span>
        </div>
        <ul>
          <For each={shown()}>
            {(s) => (
              <li>
                <RowButton
                  class="rounded-none px-4 py-2"
                  onClick={() => props.onOpen(s.summary.session_id)}
                >
                  <SessionStatusMark status={sessionStatus(s)} />
                  <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                    {displayTitle(s.title ?? s.summary.title) ?? t("common.untitled")}
                  </span>
                  <span class="min-w-0 max-w-40 shrink-0 truncate text-right text-2xs text-muted-foreground">
                    {projectLabel(s)}
                  </span>
                  <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">
                    {relTime(s.summary.last_ts, props.now)}
                  </span>
                </RowButton>
              </li>
            )}
          </For>
        </ul>
        <Show when={rest() > 0}>
          <p class="px-4 pb-2 pt-1 text-2xs tabular-nums text-muted-foreground">+{rest()}</p>
        </Show>
      </div>
    </Show>
  );
}

/**
 * The four windows as cells of one strip, each showing its own figures.
 *
 * Not a segmented control and not tiles: the point of the row is comparison,
 * and a control that hides the other three numbers cannot be compared against
 * anything. Selection is an underline, not a fill — the cells are peers of one
 * surface, so marking the pick by lifting it argued they were not.
 */
function PeriodTabs(props: {
  windows: { key: Period; totals: FleetTotals | undefined }[];
  value: Period;
  onChange: (p: Period) => void;
}) {
  const keys = () => props.windows.map((w) => w.key);
  let group: HTMLDivElement | undefined;
  const move = (e: KeyboardEvent) => {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const next = keys()[(keys().indexOf(props.value) + dir + keys().length) % keys().length]!;
    props.onChange(next);
    const cells = group?.querySelectorAll("[role=radio]");
    (cells?.[keys().indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div
      ref={group}
      class="grid grid-cols-2 rounded-lg border border-border bg-card sm:grid-cols-4"
      role="radiogroup"
      aria-label={t("fleet.usage")}
      onKeyDown={move}
    >
      <For each={props.windows}>
        {(w, i) => (
          <RowButton
            role="radio"
            aria-checked={props.value === w.key}
            tabIndex={props.value === w.key ? 0 : -1}
            class={cn(
              "group/tab relative flex-col items-start gap-1 rounded-none border-border px-4 py-3 hover:bg-secondary/40",
              i() % 2 === 1 && "border-l",
              i() >= 2 && "border-t sm:border-t-0",
              i() > 0 && "sm:border-l",
            )}
            onClick={() => props.onChange(w.key)}
          >
            <span class="text-2xs text-muted-foreground">
              {t(`fleet.period.${w.key}` as "fleet.period.total")}
            </span>
            <Tip label={w.totals ? num(tokenTotal(w.totals)) : ""}>
              <span
                class={cn(
                  "text-xl font-medium tabular-nums",
                  props.value === w.key
                    ? "text-foreground"
                    : "text-foreground/60 group-hover/tab:text-foreground/80",
                )}
              >
                {w.totals ? compactNum(tokenTotal(w.totals)) : "—"}
              </span>
            </Tip>
            <span class="truncate text-2xs text-muted-foreground">
              {w.totals ? (
                <>
                  {`${tn("fleet.overview.tileSessions", w.totals.sessions)} · `}
                  <span class="font-mono tabular-nums">{fmtUsd(w.totals.cost)}</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <Show when={props.value === w.key}>
              <span class="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />
            </Show>
          </RowButton>
        )}
      </For>
    </div>
  );
}

/**
 * The window's usage: fourteen days on the left, the window's own figures on
 * the right.
 *
 * The dollar figure is an estimate and nothing more — on a subscription it is
 * a list price nobody pays — so it sits as one row among the measured ones,
 * not as the headline.
 */
function UsageCard(props: {
  totals: FleetTotals | undefined;
  points: TrendPoint[];
  since: number;
  all: boolean;
}) {
  const parts = () =>
    TOKEN_ORDER.map((key) => ({ key, tokens: props.totals?.[key] ?? 0 })).filter((p) => p.tokens > 0);
  const row = (label: string, value: () => JSX.Element) => (
    <div class="flex items-baseline justify-between gap-4 py-1">
      <span class="text-xs text-muted-foreground">{label}</span>
      <span class="min-w-0 truncate text-right text-xs tabular-nums text-foreground">
        {props.totals ? value() : "—"}
      </span>
    </div>
  );
  return (
    <section class="grid rounded-lg border border-border bg-card md:grid-cols-[minmax(0,1fr)_15rem]">
      <TrendChart points={props.points} since={props.since} all={props.all} />
      <div class="border-border px-4 py-3 max-md:border-t md:border-l">
        {row(t("fleet.overview.estCost"), () => (
          <span class="font-mono">{fmtUsd(props.totals!.cost)}</span>
        ))}
        {row(t("fleet.overview.cacheHit"), () => fmtShare(cacheEfficiency(props.totals!) * 100))}
        {row(t("fleet.overview.tools"), () => (
          <>
            {num(props.totals!.tools)}
            <Show when={props.totals!.toolErrors > 0}>
              <span class="text-status-error">
                {` · ${t("info.tool_calls.failed", { n: num(props.totals!.toolErrors) })}`}
              </span>
            </Show>
          </>
        ))}
        <Show when={!props.totals || props.totals.sessions > 0}>
          {row(t("fleet.overview.toolsPerSession"), () =>
            (props.totals!.tools / props.totals!.sessions).toFixed(1),
          )}
        </Show>
        <div class="mt-1 flex items-center justify-between gap-4 border-t border-border py-1.5">
          <span class="text-xs text-muted-foreground">{t("fleet.overview.mix")}</span>
          <Tip
            label={
              props.totals
                ? parts()
                    .map((p) => `${t(TOKEN_LABEL[p.key])} ${num(p.tokens)}`)
                    .join(" · ")
                : ""
            }
            content={
              props.totals && parts().length > 0
                ? () => <MixTip parts={parts()} whole={tokenTotal(props.totals!)} />
                : undefined
            }
            class="block w-24"
          >
            <span class="flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <For each={parts()}>
                {(p) => (
                  <span
                    class={cn("block h-full", TOKEN_TONE[p.key])}
                    style={{ width: `${(p.tokens / tokenTotal(props.totals!)) * 100}%` }}
                  />
                )}
              </For>
            </span>
          </Tip>
        </div>
      </div>
    </section>
  );
}

/** The mix row's hover: what the thin bar is made of, spelled out. */
function MixTip(props: { parts: { key: TokenKey; tokens: number }[]; whole: number }) {
  return (
    <div class="w-44">
      <div class="flex flex-col gap-1">
        <For each={props.parts}>
          {(p) => (
            <div class="flex items-baseline gap-1.5">
              <span class={cn("size-1.5 shrink-0 rounded-full", TOKEN_TONE[p.key])} />
              <span class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                {t(TOKEN_LABEL[p.key])}
              </span>
              <span class="text-2xs tabular-nums text-foreground">{num(p.tokens)}</span>
              <span class="w-10 shrink-0 text-right text-2xs tabular-nums text-muted-foreground/60">
                {fmtShare(shareOf(p.tokens, props.whole))}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Fourteen days of tokens as a column each.
 *
 * Days outside the selected window stay drawn but drop back, so the tabs
 * above are legible down here: picking "this week" dims the seven columns
 * before it instead of re-drawing the chart at a different width, which is
 * what makes the two read as one scope rather than two independent filters.
 */
function TrendChart(props: { points: TrendPoint[]; since: number; all: boolean }) {
  const max = () => Math.max(...props.points.map((p) => p.tokens), 0);
  const height = (p: TrendPoint) => {
    const top = max();
    if (!(p.tokens > 0) || !(top > 0)) return "2px";
    return `${Math.max(6, (p.tokens / top) * 100)}%`;
  };
  const inScope = (p: TrendPoint) => props.all || p.day >= props.since;
  const total = () => props.points.reduce((sum, p) => sum + p.tokens, 0);
  const today = () => props.points.at(-1);
  return (
    <div class="min-w-0 px-4 py-3">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-2xs text-muted-foreground">{t("fleet.overview.trend")}</span>
        <span class="text-2xs tabular-nums text-muted-foreground/60">{compactNum(total())}</span>
      </div>
      <div class="relative mt-3">
        {/* A faint ceiling so a bar's height has something to be measured
            against; the figure on it is the day that ceiling belongs to. */}
        <Show when={max() > 0}>
          <span class="absolute inset-x-0 top-0 flex items-center gap-1.5">
            <span class="text-[10px] leading-none tabular-nums text-muted-foreground/60">
              {compactNum(max())}
            </span>
            <span class="h-px min-w-0 flex-1 bg-border/60" />
          </span>
        </Show>
        <div class="flex h-14 items-end gap-[3px]">
          <For each={props.points}>
            {(p) => (
              <Tip
                label={`${p.label} · ${num(p.tokens)} · ${tn("fleet.overview.sessionCount", p.sessions)}`}
                content={() => <TrendTip point={p} />}
                class="group/bar flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                {/* A day with no tokens gets the quiet track, not a 2px bar in the
                    token colour. Painted at full opacity it reads as a little
                    activity every single day, which is the one thing a strip
                    this shape must not imply. */}
                <span
                  class={cn(
                    "block w-full rounded-t-sm transition-colors",
                    p.tokens > 0
                      ? "bg-chart-1/70 group-hover/bar:bg-chart-1"
                      : "bg-foreground/10 group-hover/bar:bg-foreground/20",
                    !inScope(p) && "opacity-25",
                  )}
                  style={{ height: height(p) }}
                />
              </Tip>
            )}
          </For>
        </div>
      </div>
      <div class="mt-1.5 flex gap-[3px]">
        <For each={props.points}>
          {(p, i) => (
            <span
              class={cn(
                "min-w-0 flex-1 text-center text-[10px] leading-none tabular-nums",
                p === today() ? "text-foreground" : "text-muted-foreground/60",
              )}
              classList={{ "opacity-0": !labelled(i(), props.points.length) }}
            >
              {p.label}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Every third day, plus today.
 *
 * Today is the day a reader looks for, so it is always labelled and drawn in
 * the foreground tone even when it would crowd the previous label — a reader
 * can tell "10/18" is today's column because it is the one under the newest
 * bar.
 */
function labelled(index: number, total: number): boolean {
  return index % 3 === 0 || index === total - 1;
}

/** The numbers a bar stands for, spelled out instead of squinted at. */
function TrendTip(props: { point: TrendPoint }) {
  const parts = () =>
    TOKEN_ORDER.map((key) => ({ key, tokens: props.point.parts[key] })).filter((p) => p.tokens > 0);
  return (
    <div class="w-44">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-xs font-medium text-foreground">{props.point.label}</span>
        <span class="text-2xs tabular-nums text-muted-foreground">{num(props.point.tokens)}</span>
      </div>
      <div class="mt-1.5 flex flex-col gap-1">
        <For each={parts()}>
          {(p) => (
            <div class="flex items-baseline gap-1.5">
              <span class={cn("size-1.5 shrink-0 rounded-full", TOKEN_TONE[p.key])} />
              <span class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                {t(TOKEN_LABEL[p.key])}
              </span>
              <span class="text-2xs tabular-nums text-foreground">{num(p.tokens)}</span>
            </div>
          )}
        </For>
        <div class="mt-0.5 flex items-baseline justify-between gap-3 border-t border-border pt-1">
          <span class="text-2xs text-muted-foreground">{t("fleet.overview.estCost")}</span>
          <span class="font-mono text-2xs tabular-nums text-foreground">{fmtUsd(props.point.cost)}</span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-2xs text-muted-foreground">{t("fleet.overview.sessions")}</span>
          <span class="text-2xs tabular-nums text-foreground">{num(props.point.sessions)}</span>
        </div>
      </div>
    </div>
  );
}

function ProjectRow(props: {
  project: { workspace?: string; sessions: number; cost: number; tokens: number };
  part: number;
  whole: number;
  onOpen?: () => void;
}) {
  return (
    <Show
      when={props.onOpen}
      fallback={
        <div class="px-4 py-3">
          <ProjectBody project={props.project} part={props.part} whole={props.whole} />
        </div>
      }
    >
      <RowButton class="rounded-none px-4 py-3" onClick={() => props.onOpen?.()}>
        <ProjectBody project={props.project} part={props.part} whole={props.whole} />
      </RowButton>
    </Show>
  );
}

function ProjectBody(props: {
  project: { workspace?: string; sessions: number; cost: number; tokens: number };
  part: number;
  whole: number;
}) {
  // One column, explicitly. These used to be sibling spans straight into the
  // row's flex container, which laid them out left to right — the name ran into
  // the path ran into the bar, and a long path like D:\Games\World of Warcraft
  // pushed past the card edge with nothing to truncate against.
  return (
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-sm text-foreground">
          {props.project.workspace ? projectName(props.project.workspace) : t("sidebar.project.none")}
        </span>
        <span
          class="shrink-0 text-2xs tabular-nums text-muted-foreground"
          title={`${t("fleet.overview.estCost")} ${fmtUsd(props.project.cost)}`}
        >
          {compactNum(props.project.tokens)}
        </span>
      </span>
      <span class="mt-0.5 flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {props.project.workspace ?? ""}
        </span>
        <span class="shrink-0 text-2xs text-muted-foreground/70">
          {tn("sidebar.sessionCount", props.project.sessions)}
        </span>
      </span>
      <span class="mt-2 block">
        <Bar part={props.part} whole={props.whole} showShare />
      </span>
    </span>
  );
}

/** A model's share of the window. Not a row button: there is nowhere a model
 *  opens to, so a click target here would promise a page that does not exist. */
function ModelBody(props: {
  model: { model: string | null; tokens: number; cost: number; sessions: number };
  whole: number;
}) {
  return (
    <span class="flex min-w-0 flex-col">
      <span class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
          {modelIdPart(props.model.model) ?? t("fleet.model.unknown")}
        </span>
        <span
          class="shrink-0 text-2xs tabular-nums text-muted-foreground"
          title={`${t("fleet.overview.estCost")} ${fmtUsd(props.model.cost)}`}
        >
          {compactNum(props.model.tokens)}
        </span>
      </span>
      <span class="mt-0.5 flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {providerIdPart(props.model.model) ?? ""}
        </span>
        <span class="shrink-0 text-2xs text-muted-foreground/70">
          {tn("sidebar.sessionCount", props.model.sessions)}
        </span>
      </span>
      <span class="mt-2 block">
        <Bar part={props.model.tokens} whole={props.whole} showShare />
      </span>
    </span>
  );
}

/**
 * A share of a whole. `showShare` puts the number on the end, because a bar
 * with no figure beside it asks the reader to do the division themselves —
 * the activity column already does exactly that with its two side figures.
 */
function Bar(props: { part: number; whole: number; showShare?: boolean }) {
  const share = () => shareOf(props.part, props.whole);
  const width = () => {
    const n = share();
    if (n <= 0) return "0%";
    return `${Math.max(n, 2)}%`;
  };
  return (
    <span class="flex items-center gap-2">
      <span class="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
        <span class="block h-full rounded-full bg-foreground/55" style={{ width: width() }} />
      </span>
      <Show when={props.showShare && share() > 0}>
        <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">{fmtShare(share())}</span>
      </Show>
    </span>
  );
}
