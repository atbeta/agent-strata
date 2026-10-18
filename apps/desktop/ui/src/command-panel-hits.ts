import type { SessionRow, StrataEvent } from "./api";
import { realWorkspace } from "./api";
import { eventText, previewWindow, type PreviewWindow } from "./search-format";
import type { AppCommand } from "./commands";

/**
 * What one row of the command panel offers.
 *
 * Three kinds, because three different things are worth looking up and they
 * behave differently when you press Enter: a command runs, a session opens, a
 * transcript hit opens the session *and* lands on the line it matched.
 *
 * They share one list and one keyboard cursor on purpose. The reader types a
 * word and does not know yet which kind they will land on, and a panel that
 * made them guess before searching would be worse than no panel.
 */
export type PanelHit =
  | { kind: "heading"; key: string; label: string }
  | { kind: "command"; key: string; cmd: AppCommand }
  | { kind: "session"; key: string; id: string; title: string; hint: string }
  | {
      kind: "event";
      key: string;
      sessionId: string;
      type: string;
      preview: PreviewWindow;
      when: string;
    };

/** The groups, in the order a reader meets them. */
export const PANEL_GROUPS = ["command", "session", "event"] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

export const SESSION_LIMIT = 8;
export const EVENT_LIMIT = 12;

function projectLabel(path?: string | null): string {
  if (!path) return "";
  if (path === "/" || path === "\\") return "";
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** The three groups that get a heading, in palette order. */
export function groupOf(hit: PanelHit): PanelGroup | undefined {
  if (hit.kind === "command") return "command";
  if (hit.kind === "session") return "session";
  if (hit.kind === "event") return "event";
  return undefined;
}

/**
 * The list the panel shows.
 *
 * Empty query shows the commands and nothing else: a page of transcript hits
 * for a search nobody typed is noise, and the commands are what the panel is
 * for when it is opened rather than aimed. Once there is a query, all three
 * kinds are searched, because at that point the reader is looking for one of
 * them and the other two cost nothing but two headings.
 *
 * A group that matched nothing contributes no heading. Three headings over
 * empty runs is worse than the flat list it replaced.
 */
export function buildPanelHits(input: {
  query: string;
  commands: readonly AppCommand[];
  sessions: readonly SessionRow[];
  events: readonly StrataEvent[] | undefined;
  label: (group: string) => string;
  commandGroupLabel: (id: string) => string;
}): PanelHit[] {
  const q = input.query.trim().toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(q);

  const commands = input.commands.filter((cmd) => !q || has(cmd.title()));
  const sessions = q
    ? input.sessions
        .filter((s) => {
          const title = (s.title ?? s.summary.title ?? s.summary.session_id).toLowerCase();
          const ws = (realWorkspace(s.workspace ?? s.summary.workspace) ?? "").toLowerCase();
          return title.includes(q) || ws.includes(q);
        })
        .slice(0, SESSION_LIMIT)
        .map((s) => ({
          kind: "session" as const,
          key: `session:${s.summary.session_id}`,
          id: s.summary.session_id,
          title: s.title ?? s.summary.title ?? "",
          hint: projectLabel(realWorkspace(s.workspace ?? s.summary.workspace)),
        }))
    : [];
  /**
   * Transcript hits arrive already filtered.
   *
   * They do not match the query here, and must not: this list reads them out of
   * the list the service returned, which asked `/events` for the same query and
   * ranked what came back. Filtering a ranked result set a second time, by a
   * substring, throws away the ranking and can empty it — the search is over the
   * prose of a conversation, and the tool that found it is the one that knows
   * which line matched.
   */
  const events = q
    ? (input.events ?? []).slice(0, EVENT_LIMIT).map((e) => ({
        kind: "event" as const,
        key: `event:${e.id}`,
        sessionId: e.session_id,
        type: e.type,
        preview: previewWindow(eventText(e), q),
        when: e.ts.slice(0, 16).replace("T", " "),
      }))
    : [];

  // Commands keep their own grouping, which is read off the id: window, the
  // session, the panes. Two commands that land under different headings and one
  // that lands under neither are all cases, so the catch-all keeps its own.
  const bySubgroup = new Map<string, AppCommand[]>();
  for (const cmd of commands) {
    const subgroup = input.commandGroupLabel(cmd.id);
    bySubgroup.set(subgroup, [...(bySubgroup.get(subgroup) ?? []), cmd]);
  }

  const out: PanelHit[] = [];
  const push = (heading: string, hits: PanelHit[]) => {
    if (!hits.length) return;
    out.push({ kind: "heading", key: heading, label: input.label(heading) });
    out.push(...hits);
  };

  for (const [subgroup, cmds] of bySubgroup) {
    push(
      subgroup,
      cmds.map((cmd) => ({ kind: "command" as const, key: `command:${cmd.id}`, cmd })),
    );
  }
  push("session", sessions);
  push("event", events);
  return out;
}

/** The rows Enter can act on. Headings are in the list but not in this. */
export function actionable(hits: readonly PanelHit[]): PanelHit[] {
  return hits.filter((h) => h.kind !== "heading");
}

/**
 * Which selectable row the one at `index` is, counting only selectable rows.
 *
 * The keyboard cursor is an index into `actionable`, so the highlight has to be
 * an index into the same thing. Counting positions in the visible list instead
 * lights a line one off — or several, under a heading — the moment the list
 * stopped being flat.
 */
export function actionableIndexAt(hits: readonly PanelHit[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < hits.length; i++) if (hits[i]!.kind !== "heading") n++;
  return n;
}
