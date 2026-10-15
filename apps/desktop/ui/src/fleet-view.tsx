import { For, Show, type JSX } from "solid-js";
import { fmtUsd, fmtUsdFlat, realWorkspace, type SessionRow } from "./api";
import { sessionStatus } from "./session-status";
import { SessionStatusMark } from "@/components/ui/session-status";
import {
  fleetActivity,
  fleetAttention,
  fleetProjects,
  fleetRecent,
  fleetTotals,
  projectName,
  relTime,
  shareOf,
} from "./fleet";
import { compactNum, num, t, tn } from "./i18n";
import { RowButton } from "@/components/ui/row-button";

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
 * Figures are summed from the rows already in hand, so filtering to a project
 * narrows the page to match the list.
 */
export function FleetView(props: {
  sessions: SessionRow[];
  /** A single directory is selected, so the right column is time rather than projects. */
  scoped: boolean;
  now: number;
  onOpen: (id: string) => void;
  onOpenProject: (directory: string) => void;
}) {
  const totals = () => fleetTotals(props.sessions);
  const recent = () => fleetRecent(props.sessions);
  const attention = () => fleetAttention(props.sessions);
  const projects = () => fleetProjects(props.sessions);
  const activity = () => fleetActivity(props.sessions, props.now);
  const tokens = () => totals().input + totals().output;
  const inPct = () => Math.round(shareOf(totals().input, tokens()));

  const projectSpend = () => projects().reduce((sum, p) => sum + p.cost, 0);
  const projectWhole = () =>
    projectSpend() > 0 ? projectSpend() : projects().reduce((sum, p) => sum + p.sessions, 0);
  const activitySpend = () => activity().reduce((sum, b) => sum + b.cost, 0);
  const activityWhole = () =>
    activitySpend() > 0 ? activitySpend() : activity().reduce((sum, b) => sum + b.sessions, 0);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="grid shrink-0 grid-cols-4 border-b border-border">
        <Stat label={t("fleet.overview.sessions")} value={num(totals().sessions)}>
          <Show when={!props.scoped && totals().projects > 0}>
            <span class="truncate text-2xs text-muted-foreground">
              {tn("fleet.overview.projectCount", totals().projects)}
            </span>
          </Show>
        </Stat>
        <Stat label={t("fleet.overview.cost")} value={fmtUsd(totals().cost)}>
          <Show when={totals().sessions > 0 && totals().cost > 0}>
            <span class="truncate font-mono text-2xs text-muted-foreground">
              {t("fleet.overview.perSession", { value: fmtUsd(totals().cost / totals().sessions) })}
            </span>
          </Show>
        </Stat>
        <Stat label={t("fleet.overview.tokens")} value={compactNum(tokens())}>
          <Show when={tokens() > 0}>
            <span
              class="flex min-w-0 flex-1 items-center gap-2"
              title={`${t("fleet.overview.input")} ${num(totals().input)} · ${t("fleet.overview.output")} ${num(totals().output)}`}
            >
              {/* Two segments that together fill the track, not one bar that
                  happens to stop at 90%. A single fill is a quota meter — it
                  says "this is running out", which is exactly the wrong thing to
                  imply about a split between prompt and completion. Drawing both
                  ends is what makes it read as a composition. */}
              <span class="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
                <span class="block h-full bg-foreground/55" style={{ width: `${inPct()}%` }} />
                <span class="block h-full bg-event-tool/50" style={{ width: `${100 - inPct()}%` }} />
              </span>
              <span class="shrink-0 text-2xs text-muted-foreground">
                {t("fleet.overview.input")} {inPct()}%
              </span>
            </span>
          </Show>
        </Stat>
        <Stat label={t("fleet.overview.tools")} value={num(totals().tools)} />
      </div>

      <Show
        when={props.sessions.length > 0}
        fallback={
          <div class="flex flex-1 items-start px-8 py-16">
            <p class="text-sm text-muted-foreground">{t("fleet.overview.empty")}</p>
          </div>
        }
      >
        <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
          <section class="min-h-0 overflow-y-auto">
            <h2 class="sticky top-0 z-10 bg-background px-5 pt-4 pb-2 text-2xs text-muted-foreground">
              {t("fleet.overview.recent")}
            </h2>
            <ul class="divide-y divide-border">
              <For each={recent()}>
                {(s) => {
                  const sub = () => recentSub(s, props.scoped);
                  return (
                    <li>
                      <RowButton
                        class="items-start gap-3 rounded-none px-5 py-2.5"
                        onClick={() => props.onOpen(s.summary.session_id)}
                      >
                        <SessionStatusMark status={sessionStatus(s)} class="mt-1" />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm text-foreground">
                            {s.title ?? s.summary.title ?? t("common.untitled")}
                          </span>
                          <Show when={sub()}>
                            <span class="mt-0.5 block truncate text-2xs text-muted-foreground">{sub()}</span>
                          </Show>
                        </span>
                        <span class="shrink-0 text-right">
                          <Show when={s.totals.cost_usd > 0}>
                            <span class="block font-mono text-2xs tabular-nums text-muted-foreground">
                              {fmtUsd(s.totals.cost_usd)}
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
          </section>

          <aside class="min-h-0 overflow-y-auto border-l border-border">
            <Show when={attention().length > 0}>
              <section class="border-b border-border">
                <h2 class="px-5 pt-4 pb-2 text-2xs text-muted-foreground">{t("fleet.overview.attention")}</h2>
                <ul class="divide-y divide-border">
                  <For each={attention()}>
                    {(s) => (
                      <li>
                        <RowButton
                          class="rounded-none px-5 py-2.5"
                          onClick={() => props.onOpen(s.summary.session_id)}
                        >
                          <SessionStatusMark status={sessionStatus(s)} />
                          <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                            {s.title ?? s.summary.title ?? t("common.untitled")}
                          </span>
                        </RowButton>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <Show
              when={!props.scoped}
              fallback={
                <section>
                  <h2 class="px-5 pt-4 pb-2 text-2xs text-muted-foreground">{t("fleet.overview.activity")}</h2>
                  <ul>
                    <For each={activity()}>
                      {(b) => (
                        <li class="px-5 py-2.5">
                          <div class="flex items-center gap-3">
                            <span class="shrink-0 text-sm text-foreground">{t(b.key)}</span>
                            <span class="min-w-0 flex-1">
                              <Bar
                                part={activitySpend() > 0 ? b.cost : b.sessions}
                                whole={activityWhole()}
                              />
                            </span>
                            <span class="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                              {num(b.sessions)}
                            </span>
                            <span class="shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                              {fmtUsdFlat(b.cost)}
                            </span>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              }
            >
              <section>
                <h2 class="px-5 pt-4 pb-2 text-2xs text-muted-foreground">{t("fleet.overview.projects")}</h2>
                <ul class="divide-y divide-border">
                  <For each={projects()}>
                    {(p) => (
                      <li>
                        <ProjectRow
                          project={p}
                          part={projectSpend() > 0 ? p.cost : p.sessions}
                          whole={projectWhole()}
                          onOpen={p.workspace ? () => props.onOpenProject(p.workspace!) : undefined}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </aside>
        </div>
      </Show>
    </div>
  );
}

function recentSub(s: SessionRow, scoped: boolean): string {
  const tokensOf = s.totals.input + s.totals.output;
  if (scoped) return tokensOf > 0 ? `${num(tokensOf)} ${t("fleet.overview.tokens")}` : "";
  const ws = realWorkspace(s.workspace ?? s.summary.workspace);
  return ws ? projectName(ws) : t("sidebar.project.none");
}

function Stat(props: { label: string; value: string; children?: JSX.Element }) {
  // The detail line is optional. Its height stays either way, so the four figures share one baseline.
  return (
    <div class="min-w-0 border-border px-5 py-4 [&:not(:last-child)]:border-r">
      <div class="text-2xs text-muted-foreground">{props.label}</div>
      <div class="mt-1.5 truncate font-mono text-xl leading-none tabular-nums text-foreground">{props.value}</div>
      <div class="mt-2 flex h-4 min-w-0 items-center">{props.children}</div>
    </div>
  );
}

function ProjectRow(props: {
  project: { workspace?: string; sessions: number; cost: number };
  part: number;
  whole: number;
  onOpen?: () => void;
}) {
  return (
    <Show
      when={props.onOpen}
      fallback={
        <div class="px-5 py-3">
          <ProjectBody project={props.project} part={props.part} whole={props.whole} />
        </div>
      }
    >
      <RowButton
        class="rounded-none px-5 py-3"
        onClick={() => props.onOpen?.()}
      >
        <ProjectBody project={props.project} part={props.part} whole={props.whole} />
      </RowButton>
    </Show>
  );
}

function ProjectBody(props: {
  project: { workspace?: string; sessions: number; cost: number };
  part: number;
  whole: number;
}) {
  return (
    <>
      <span class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-sm text-foreground">
          {props.project.workspace ? projectName(props.project.workspace) : t("sidebar.project.none")}
        </span>
        <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {fmtUsdFlat(props.project.cost)}
        </span>
      </span>
      <span class="mt-0.5 flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {props.project.workspace ?? ""}
        </span>
        <span class="shrink-0 text-2xs text-muted-foreground">{tn("sidebar.sessionCount", props.project.sessions)}</span>
      </span>
      <span class="mt-2 block">
        <Bar part={props.part} whole={props.whole} showShare />
      </span>
    </>
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
