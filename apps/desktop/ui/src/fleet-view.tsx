import { createSignal, For, Show, type JSX } from "solid-js";
import { fmtUsd, realWorkspace, type SessionRow } from "./api";
import { sessionStatus } from "./session-status";
import { SessionStatusMark } from "@/components/ui/session-status";
import {
  cacheEfficiency,
  fleetAttention,
  fleetProjects,
  fleetRecent,
  fleetTotals,
  fleetTrend,
  inPeriod,
  PERIODS,
  periodStart,
  projectName,
  relTime,
  shareOf,
  tokenParts,
  tokenTotal,
  type Period,
  type TokenKey,
  type TokenPart,
  type TrendPoint,
} from "./fleet";
import { compactNum, num, t, tn } from "./i18n";
import { RowButton } from "@/components/ui/row-button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChoiceCard } from "@/components/ui/choice-card";
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
  output: "bg-chart-2",
  cacheRead: "bg-chart-3",
  cacheWrite: "bg-chart-4",
};

/** `satisfies` rather than an annotation: the labels have to stay literal, or
 *  `t()` widens them to `string` and the key check stops being a check. */
const TOKEN_LABEL = {
  input: "fleet.tokens.input",
  output: "fleet.tokens.output",
  cacheRead: "fleet.tokens.cacheRead",
  cacheWrite: "fleet.tokens.cacheWrite",
} as const satisfies Record<TokenKey, string>;

const TREND_DAYS = 14;

/**
 * The landing pane.
 *
 * The sidebar is already the list of sessions, so this does not repeat "pick
 * one" as its only job. It answers what the list cannot: what the current
 * scope has cost, which directories the spend sits in, and which sessions are
 * waiting on a person. The way back lives in the sidebar, not on this page —
 * once a session is open the overview is a peer of it, not a parent you drill
 * out of.
 *
 * The period switcher is the one piece of state this page owns. Everything
 * else is summed from the rows already in hand, so filtering to a project
 * narrows the page to match the list, and the switcher narrows it further
 * without ever leaving that set.
 */
export function FleetView(props: {
  sessions: SessionRow[];
  now: number;
  onOpen: (id: string) => void;
  onOpenProject: (directory: string) => void;
}) {
  const [period, setPeriod] = createSignal<Period>("total");

  /** All four windows at once: the switcher shows each one's own figures. */
  const windows = () =>
    PERIODS.map((key) => ({ key, totals: fleetTotals(inPeriod(props.sessions, key, props.now)) }));
  const scoped = () => inPeriod(props.sessions, period(), props.now);
  const totals = () => fleetTotals(scoped());
  const recent = () => fleetRecent(scoped());
  const attention = () => fleetAttention(props.sessions);
  const projects = () => fleetProjects(props.sessions);

  const cacheHit = () => cacheEfficiency(totals());
  const trend = () => fleetTrend(props.sessions, props.now, TREND_DAYS);

  // The share bar divides one measure against itself, so it has to be the same
  // measure the row shows: tokens, not the dollar figure that now sits below it.
  const projectTokens = () => projects().reduce((sum, p) => sum + p.tokens, 0);
  const projectWhole = () =>
    projectTokens() > 0 ? projectTokens() : projects().reduce((sum, p) => sum + p.sessions, 0);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-4">
          <Show when={attention().length > 0}>
            <AttentionBanner rows={attention()} onOpen={props.onOpen} />
          </Show>

          <PeriodPicker windows={windows()} value={period()} onChange={setPeriod} />

          <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
            {/* Tokens lead and take two columns. Under a subscription the
                dollar figure is a list price the reader never pays, so it stops
                being a peer of the one number that is real and becomes a footnote
                on the card it qualifies. */}
            <TokenCard
              class="col-span-2"
              parts={tokenParts(totals())}
              cacheHit={cacheHit()}
              cost={totals().cost}
              perSessionCost={totals().sessions > 0 ? totals().cost / totals().sessions : 0}
            />
            <StatCard
              label={t("fleet.overview.sessions")}
              value={num(totals().sessions)}
              tone="bg-chart-1"
            >
              <Show when={totals().projects > 0}>
                <span class="truncate text-2xs text-muted-foreground">
                  {tn("fleet.overview.projectCount", totals().projects)}
                </span>
              </Show>
            </StatCard>
            <StatCard
              label={t("fleet.overview.tools")}
              value={num(totals().tools)}
              tone="bg-chart-4"
            >
              <Show when={totals().sessions > 0 && totals().tools > 0}>
                {/* Split, not wrapped: `font-mono` has no CJK face, so a Chinese
                    label inside one falls through to SimSun and the line reads
                    as a different typeface from the label above it. */}
                <span class="truncate text-2xs text-muted-foreground">
                  {t("fleet.overview.perSessionTools")}
                  <span class="ml-1 font-mono tabular-nums text-foreground/70">
                    {num(Math.round(totals().tools / totals().sessions))}
                  </span>
                </span>
              </Show>
            </StatCard>
          </div>

          <TrendCard
            points={trend()}
            since={periodStart(period(), props.now)}
            all={period() === "total"}
          />

          <Show
            when={props.sessions.length > 0}
            fallback={
              <div class="flex flex-1 items-center justify-center py-10">
                <EmptyState icon="list" title={t("fleet.overview.empty")} />
              </div>
            }
          >
            <div class="grid grid-cols-1 items-start gap-4 pb-2 md:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)]">
              <section class="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                <CardHead label={t("fleet.overview.recent")} count={recent().length} />
                <Show
                  when={recent().length > 0}
                  fallback={<p class="px-4 py-6 text-2xs text-muted-foreground">{t("fleet.overview.emptyPeriod")}</p>}
                >
                  <ul class="divide-y divide-border">
                    <For each={recent()}>
                      {(s) => {
                        const sub = () => recentSub(s);
                        return (
                          <li>
                            <RowButton
                              class="items-start gap-3 rounded-none px-4 py-2.5"
                              onClick={() => props.onOpen(s.summary.session_id)}
                            >
                              <SessionStatusMark status={sessionStatus(s)} class="mt-1" />
                              <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm text-foreground">
                                  {s.title ?? s.summary.title ?? t("common.untitled")}
                                </span>
                                <Show when={sub()}>
                                  <span class="mt-0.5 block truncate text-2xs text-muted-foreground">
                                    {sub()}
                                  </span>
                                </Show>
                              </span>
                              <span class="shrink-0 text-right">
                                <Show when={sessionTokens(s) > 0}>
                                  <span
                                    class="block font-mono text-2xs tabular-nums text-muted-foreground"
                                    title={`${t("fleet.overview.estCost")} ${fmtUsd(s.totals.cost_usd)}`}
                                  >
                                    {compactNum(sessionTokens(s))}
                                  </span>
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
              </section>

              <section class="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                <CardHead label={t("fleet.overview.projects")} count={projects().length} />
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
              </section>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function recentSub(s: SessionRow): string {
  const ws = realWorkspace(s.workspace ?? s.summary.workspace);
  return ws ? projectName(ws) : t("sidebar.project.none");
}

/** What one row of the list is measured in. Same measure as the panels above it. */
function sessionTokens(s: SessionRow): number {
  return (
    s.totals.input + s.totals.output + s.totals.cache_read + s.totals.cache_write
  );
}

/**
 * The sessions that are waiting on somebody, at the top of the page.
 *
 * This used to sit in the right rail under a section header, which meant the
 * one thing on the page that asks for action was the thing a reader scrolled
 * past. A session stopped at a permission prompt is doing nothing until a
 * person answers it, so it earns the first row rather than the second screen.
 */
function AttentionBanner(props: { rows: SessionRow[]; onOpen: (id: string) => void }) {
  const shown = () => props.rows.slice(0, 5);
  const rest = () => props.rows.length - shown().length;
  return (
    <section class="flex items-stretch gap-4 rounded-lg border border-event-permission/30 bg-card px-4 py-3">
      <span class="flex shrink-0 flex-col justify-center gap-1 border-r border-border pr-4">
        <span class="text-2xs text-muted-foreground">{t("fleet.overview.attention")}</span>
        <span class="font-mono text-xl leading-none tabular-nums text-foreground">
          {props.rows.length}
        </span>
      </span>
      <div class="flex min-w-0 flex-1 flex-wrap content-center items-center gap-1.5">
        <For each={shown()}>
          {(s) => (
            <RowButton
              class="w-auto max-w-56 gap-1.5 border border-border bg-secondary/50 px-2 py-1 text-xs hover:bg-secondary"
              onClick={() => props.onOpen(s.summary.session_id)}
            >
              <SessionStatusMark status={sessionStatus(s)} />
              <span class="min-w-0 truncate">{s.title ?? s.summary.title ?? t("common.untitled")}</span>
            </RowButton>
          )}
        </For>
        <Show when={rest() > 0}>
          <span class="px-1 font-mono text-2xs text-muted-foreground">+{rest()}</span>
        </Show>
      </div>
    </section>
  );
}

/**
 * The four windows, each showing its own figures.
 *
 * Not a segmented control: the point of the row is comparison, and a control
 * that hides the other three numbers cannot be compared against anything. Each
 * card answers "what did this window cost" before you click it, so switching is
 * a way to change the scope of the page below rather than a guess.
 */
function PeriodPicker(props: {
  windows: { key: Period; totals: ReturnType<typeof fleetTotals> }[];
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <For each={props.windows}>
        {(w) => (
          <ChoiceCard
            mode="radio"
            selected={props.value === w.key}
            onSelect={() => props.onChange(w.key)}
          >
            {/* ChoiceCard puts children in one inline span, so the three lines
                need their own column — as bare spans they run together on one. */}
            <span class="flex flex-col gap-0.5">
              <span class="text-2xs text-muted-foreground">
                {t(`fleet.period.${w.key}` as "fleet.period.total")}
              </span>
              <span class="truncate font-mono text-sm leading-tight tabular-nums text-foreground">
                {compactNum(tokenTotal(w.totals))}
              </span>
              <span class="truncate font-mono text-2xs tabular-nums text-muted-foreground">
                {fmtUsd(w.totals.cost)}
              </span>
            </span>
          </ChoiceCard>
        )}
      </For>
    </div>
  );
}

/**
 * A figure with a colour bar over it.
 *
 * The bar is the whole reason the four read as one system rather than four
 * numbers: each is the colour the app already gives that meaning elsewhere, so
 * a reader who has seen the sidebar knows the green one is activity before
 * reading the label under it.
 */
function StatCard(props: { label: string; value: string; tone: string; children?: JSX.Element }) {
  return (
    <div class="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card px-4 py-3">
      <span class={cn("absolute inset-x-0 top-0 h-0.5", props.tone)} />
      <span class="text-2xs text-muted-foreground">{props.label}</span>
      <span class="mt-1.5 truncate font-mono text-xl leading-none tabular-nums text-foreground">
        {props.value}
      </span>
      <span class="mt-2 flex h-4 min-w-0 items-center">{props.children}</span>
    </div>
  );
}

function CardHead(props: { label: string; count?: number }) {
  return (
    <div class="flex items-baseline gap-2 border-b border-border px-4 py-2.5">
      <span class="text-2xs text-muted-foreground">{props.label}</span>
      <Show when={props.count !== undefined}>
        <span class="font-mono text-2xs tabular-nums text-muted-foreground/60">{props.count}</span>
      </Show>
    </div>
  );
}

/**
 * The page's lead figure: how many tokens the window cost, and what they were.
 *
 * Four segments rather than the two the previous version drew, because the two
 * that were missing are the interesting ones: a prompt served from cache is
 * traffic the provider did not bill for, and hiding it inside "input" makes a
 * cheap session look like an expensive one. The legend carries the figures, so
 * the reader does not have to measure the bar.
 *
 * The dollar figure lives in the footer, as an estimate and nothing more. On a
 * subscription it is a list price nobody pays, and a number that sits at the
 * same weight as the token count beside it claims a precision it does not have.
 */
function TokenCard(props: {
  parts: TokenPart[];
  cacheHit: number;
  cost: number;
  perSessionCost: number;
  class?: string;
}) {
  const total = () => props.parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <section
      class={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card px-4 py-3",
        props.class,
      )}
    >
      <span class="absolute inset-x-0 top-0 h-0.5 bg-chart-5" />
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-2xs text-muted-foreground">{t("fleet.overview.tokens")}</span>
        <Show when={props.cacheHit > 0}>
          <span class="text-2xs text-muted-foreground">
            {t("fleet.overview.cacheHit")}
            <span class="ml-1 font-mono tabular-nums text-foreground/80">
              {Math.round(props.cacheHit * 100)}%
            </span>
          </span>
        </Show>
      </div>
      <span class="mt-1.5 truncate font-mono text-2xl leading-none tabular-nums text-foreground">
        {compactNum(total())}
      </span>

      <Show
        when={props.parts.length > 0}
        fallback={
          <p class="py-4 text-2xs text-muted-foreground">{t("fleet.overview.tokens.empty")}</p>
        }
      >
        <div class="mt-3 flex h-1.5 overflow-hidden rounded-full bg-foreground/10">
          <For each={props.parts}>
            {(part) => (
              <span
                class={cn("block h-full", TOKEN_TONE[part.key])}
                style={{ width: `${part.pct}%` }}
                title={`${t(TOKEN_LABEL[part.key])} ${num(part.value)}`}
              />
            )}
          </For>
        </div>
        {/* One column. A grid of four looked tidier and was wrong: each cell
            then had to hold a swatch, a three-character Chinese label, a
            figure and a percentage in ~170px, and the label — the only part
            that says what the colour means — is what gives way. A row per
            measure costs four lines and always reads. */}
        <dl class="mt-2.5 flex flex-col gap-1">
          <For each={props.parts}>
            {(part) => (
              <div class="flex min-w-0 items-baseline gap-2">
                <span class={cn("size-2 shrink-0 translate-y-px rounded-sm", TOKEN_TONE[part.key])} />
                <dt class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                  {t(TOKEN_LABEL[part.key])}
                </dt>
                <dd class="shrink-0 font-mono text-2xs tabular-nums text-foreground">
                  {compactNum(part.value)}
                </dd>
                <span class="w-9 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground/60">
                  {Math.round(part.pct)}%
                </span>
              </div>
            )}
          </For>
        </dl>
      </Show>

      <Show when={props.cost > 0}>
        <p class="mt-3 border-t border-border pt-2 text-2xs text-muted-foreground/70">
          {t("fleet.overview.estCost")}
          <span class="ml-1 font-mono tabular-nums text-muted-foreground">
            {fmtUsd(props.cost)}
          </span>
          <Show when={props.perSessionCost > 0}>
            <span class="ml-2">
              {t("fleet.overview.perSessionLabel")}
              <span class="ml-0.5 font-mono tabular-nums text-muted-foreground">
                {fmtUsd(props.perSessionCost)}
              </span>
            </span>
          </Show>
        </p>
      </Show>
    </section>
  );
}

/**
 * Fourteen days of tokens as a column each.
 *
 * Days outside the selected window stay drawn but drop back, so the switcher
 * above is legible down here: picking "this week" dims the seven columns before
 * it instead of re-drawing the chart at a different width, which is what makes
 * the two read as one scope rather than two independent filters.
 */
function TrendCard(props: { points: TrendPoint[]; since: number; all: boolean }) {
  const max = () => Math.max(...props.points.map((p) => p.tokens), 0);
  const height = (p: TrendPoint) => {
    const top = max();
    if (!(p.tokens > 0) || !(top > 0)) return "2px";
    return `${Math.max(6, (p.tokens / top) * 100)}%`;
  };
  const inScope = (p: TrendPoint) => props.all || p.day >= props.since;
  return (
    <section class="min-w-0 rounded-lg border border-border bg-card px-4 py-3">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-2xs text-muted-foreground">{t("fleet.overview.trend")}</span>
        <span class="font-mono text-2xs tabular-nums text-muted-foreground/60">
          {compactNum(props.points.reduce((sum, p) => sum + p.tokens, 0))}
        </span>
      </div>
      <div class="mt-3 flex h-14 items-end gap-[3px]">
        <For each={props.points}>
          {(p) => (
            <div
              class="group/bar flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${p.label} · ${compactNum(p.tokens)} · ${tn("fleet.overview.sessionCount", p.sessions)}`}
            >
              {/* A day with no tokens gets the quiet track, not a 2px bar in the
                  token colour. Painted at full opacity it reads as a little
                  activity every single day, which is the one thing a strip
                  this shape must not imply. */}
              <span
                class={cn(
                  "block w-full rounded-t-sm transition-colors",
                  p.tokens > 0
                    ? "bg-chart-5/70 group-hover/bar:bg-chart-5"
                    : "bg-foreground/10 group-hover/bar:bg-foreground/20",
                  !inScope(p) && "opacity-25",
                )}
                style={{ height: height(p) }}
              />
            </div>
          )}
        </For>
      </div>
      <div class="mt-1.5 flex gap-[3px]">
        <For each={props.points}>
          {(p, i) => (
            <span
              class="min-w-0 flex-1 text-center font-mono text-[9px] leading-none text-muted-foreground/60"
              classList={{ "opacity-0": !labelled(i(), props.points.length) }}
            >
              {p.label}
            </span>
          )}
        </For>
      </div>
    </section>
  );
}

/**
 * Every third day, plus the last one when it does not crowd its neighbour.
 *
 * The last day is the one a reader looks for, but pinning it unconditionally
 * puts "10/17" and "10/18" on top of each other whenever the two fall in the
 * same three-day gap — and overlapping dates are worse than a missing one,
 * because the reader cannot tell which is which.
 */
function labelled(index: number, total: number): boolean {
  if (index % 3 === 0) return true;
  const last = total - 1;
  return index === last && last - (last - (last % 3)) >= 3;
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
        <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
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
        <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {Math.round(share())}%
        </span>
      </Show>
    </span>
  );
}
