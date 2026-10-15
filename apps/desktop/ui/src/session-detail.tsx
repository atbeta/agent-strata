import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import {
  abortSession,
  api,
  addMcp,
  backendLabel,
  beginMcpLogin,
  connectMcp,
  disconnectMcp,
  finishMcpLogin,
  downloadExport,
  findFiles,
  fmtUsd,
  forkSession,
  getJson,
  importSession,
  readCapabilities,
  readCommands,
  readLsp,
  readMcp,
  realWorkspace,
  readVcs,
  readSessionDiff,
  readVcsDiff,
  readViewTail,
  respondPermission,
  respondQuestion,
  revertSession,
  runCommand,
  searchSession,
  sendPrompt,
  STATUS_DOT,
  STATUS_LABEL,
  unrevertSession,
  type McpServerStatus,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SearchHit,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { questionGroups } from "./question-payload";
import { DiffBlock } from "./diff";
import { FileBrowser } from "./files";
import { PlanStrip } from "./plan-strip";
import { planVisible } from "./plan-progress";
import { TerminalPane } from "./terminal";
import { ReviewPane } from "./review";
import { clampRailWidth, readRailWidth, writeRailWidth, RAIL_MAX, RAIL_MIN } from "./rail-width";
import {
  readPanelOpen,
  readPanelTab,
  writePanelOpen,
  writePanelTab,
  type SidePanelTab,
} from "./right-pane";
import { JsonView } from "./json-view";
import { permissionView, type PermissionView } from "./permission-card";
import { compactNum, num, t, tn } from "./i18n";
import type { MessageKey } from "./locales/zh";
import { copyText } from "./clipboard";
import { DragBar } from "./chrome";
import { inDesktopShell, shellPlatform } from "./shell";
import { Tip } from "./tip";
import { TraceDrawer, TraceStrip, type TraceBlock } from "./trace";
import { TurnBlock } from "./transcript";
import { Virtual, type VirtualApi } from "./virtual";
import { JUMP_GAP } from "./virtual-tail";
import { stopConfirmed } from "./stop-verdict";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries } from "./prompt-outline";
import { ComposerToolbar } from "./composer-toolbar";
import { applyStreamingSnapshot, mergeViewTail, type StreamingSnapshot } from "./live";
import { ECHO_TURN_ID, withEcho, type PendingEcho } from "./prompt-echo";
import { filesKeyOf, peekView, rememberView, tailMatches, viewFromTail } from "./view-cache";
import { registerCommand } from "./commands";
import { LayoutSwitcher, PaneStage, type SessionRowSummary } from "./pane-stage";
import {
  applyLayoutPreset,
  assignSessionToWorkspace,
  closePane,
  focusedLeaf,
  focusPane,
  readPaneWorkspace,
  resizeSplit,
  setPaneSession,
  splitPane,
  toggleZoomPane,
  writePaneWorkspace,
  type LayoutPreset,
  type PaneWorkspaceState,
  type SplitDir,
} from "./pane-tree";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { EmptyState } from "@/components/ui/empty-state";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { Picker } from "@/components/ui/picker";
import { RowButton } from "@/components/ui/row-button";
import { TextFieldInput } from "@/components/ui/text-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  commandOf,
  commandParts,
  insertPick,
  matchCommands,
  MAX_ATTACHMENTS,
  stepAgent,
  promptParts,
  explainSend,
  restoreFailed,
  toAttachment,
  triggerAt,
  type Attachment,
  type Outgoing,
  type Trigger,
} from "./composer-input";
import { AttachmentStrip, ComposerMenu, type MenuItem } from "./composer-menu";

/**
 * An errored Solid resource throws when read, which unmounts the whole window.
 *
 * This is the right trade for the transcript: a view that will not load has no
 * useful half-state, so showing a full-window failure beats showing nothing.
 * It is the wrong trade for the pending prompts, which live in the dock beside
 * a composer that still works. `settled()` turns a failed `/questions` fetch
 * into "there are no questions" — the card vanishes, the session sits at
 * 运行中 with nothing to answer, and nothing anywhere says why. The dock
 * reads `questions.error` directly for exactly that reason.
 */
function settled<T>(resource: { error: unknown; (): T | undefined }): T | undefined {
  return resource.error ? undefined : resource();
}
import {
  navigateHistory,
  readDraft,
  readHistory,
  rememberPrompt,
  sessionContext,
  writeDraft,
  writeHistory,
} from "./prompt-memory";

function askIcon(detail: PermissionView, tool: string): "terminal" | "pencil" | "globe" | "files" | "wrench" {
  if (detail.kind === "command") return "terminal";
  if (detail.kind === "diff") return "pencil";
  if (detail.kind === "url") return "globe";
  if (tool === "read") return "files";
  return "wrench";
}

function AskCard(props: {
  ask: PendingAsk;
  onRespond: (id: string, decision: "allow" | "deny", scope?: "once" | "always") => void;
}) {
  const detail = () => permissionView(props.ask);
  const body = () => {
    const view = detail();
    if (view.kind === "command") {
      return (
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/50 px-2.5 py-1.5 font-mono text-xs leading-5">
          {view.command}
        </pre>
      );
    }
    if (view.kind === "diff") {
      return (
        <div class="overflow-hidden rounded-md border border-border">
          <Show when={view.path}>
            <p class="truncate border-b border-border px-2.5 py-1 font-mono text-2xs text-muted-foreground">{view.path}</p>
          </Show>
          <div class="max-h-48 overflow-auto">
            <DiffBlock patch={view.patch} />
          </div>
        </div>
      );
    }
    if (view.kind === "url") {
      return <p class="break-all font-mono text-xs leading-5 text-foreground/90">{view.url}</p>;
    }
    return (
      <div class="max-h-32 overflow-auto rounded-md bg-secondary/50 px-2.5 py-1.5">
        <JsonView value={props.ask.input} />
      </div>
    );
  };
  return (
    <div class="overflow-hidden rounded-lg border border-border bg-card">
      <div class="flex items-center gap-2 px-3 pt-2.5">
        <Icon name={askIcon(detail(), props.ask.tool)} class="size-3.5 shrink-0 text-event-permission" />
        <span class="text-xs font-medium">{props.ask.tool}</span>
        <span class="text-2xs text-muted-foreground">{t("permission.wants_to_run")}</span>
      </div>
      <div class="px-3 py-2">{body()}</div>
      <div class="flex items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          class="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => props.onRespond(props.ask.request_id, "deny")}
        >
          {t("permission.deny")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="h-7"
          onClick={() => props.onRespond(props.ask.request_id, "allow", "always")}
        >
          {t("permission.always")}
        </Button>
        <Button size="sm" class="h-7" onClick={() => props.onRespond(props.ask.request_id, "allow", "once")}>
          {t("permission.once")}
        </Button>
      </div>
    </div>
  );
}

function QuestionCard(props: { q: PendingQuestion; onDone: () => void }) {
  // `/questions` arrives through a blind cast, so nothing checks its shape. An
  // entry with no `questions` used to throw on the next line — during setup,
  // before the dock could draw its error bar — and take the whole prompt area
  // with it: the agent keeps holding its turn waiting on an answer nobody can
  // see, and the region reads as empty rather than broken. Normalising here
  // keeps a malformed entry on screen and dismissible instead.
  const groups = questionGroups(props.q.questions);
  const [picks, setPicks] = createSignal<string[][]>(groups.map(() => []));
  const [custom, setCustom] = createSignal<string[]>(groups.map(() => ""));
  const [err, setErr] = createSignal("");

  const toggle = (qi: number, label: string, multiple?: boolean) => {
    setPicks((all) =>
      all.map((cur, i) => {
        if (i !== qi) return cur;
        if (multiple) return cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
        return cur[0] === label ? [] : [label];
      }),
    );
  };

  const answers = () =>
    groups.map((question, i) => {
      const selected = picks()[i] ?? [];
      const extra = custom()[i]?.trim();
      if (selected.length && extra && question.custom) return [...selected, extra];
      if (selected.length) return selected;
      return extra ? [extra] : [];
    });

  const submit = async () => {
    if (answers().some((a) => a.length === 0)) {
      setErr(t("question.err.answer_each"));
      return;
    }
    setErr("");
    await respondQuestion(props.q.request_id, "reply", answers());
    props.onDone();
  };

  return (
    <div class="overflow-hidden rounded-lg border border-border bg-card">
      <Show
        when={groups.length > 0}
        fallback={
          <div class="px-3 py-2.5">
            <div class="text-sm text-destructive">{t("question.unreadable")}</div>
            <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">
              {t("question.unreadable_hint")}
            </div>
          </div>
        }
      >
        <For each={groups}>
          {(question, qi) => (
            <div class={qi() > 0 ? "border-t border-border px-3 py-2.5" : "px-3 py-2.5"}>
              <Show when={question.header}>
                <div class="text-2xs text-muted-foreground">{question.header}</div>
              </Show>
              <p class="mt-0.5 text-sm">{question.question}</p>
              <div class="mt-2 space-y-1">
                <For each={question.options}>
                  {(opt) => {
                    const on = () => (picks()[qi()] ?? []).includes(opt.label);
                    return (
                      <ChoiceCard
                        mode="press"
                        check
                        selected={on()}
                        onSelect={() => toggle(qi(), opt.label, question.multiple)}
                      >
                        <span class="block text-sm">{opt.label}</span>
                        <Show when={opt.description}>
                          <span class="mt-0.5 block text-2xs leading-4 text-muted-foreground">{opt.description}</span>
                        </Show>
                      </ChoiceCard>
                    );
                  }}
                </For>
              </div>
              <Show when={question.custom}>
                <TextFieldInput
                  size="sm"
                  class="mt-2"
                  placeholder={t("question.placeholder.custom")}
                  value={custom()[qi()] ?? ""}
                  onInput={(e) =>
                    setCustom((all) => all.map((v, i) => (i === qi() ? e.currentTarget.value : v)))
                  }
                />
              </Show>
            </div>
          )}
        </For>
      </Show>
      <div class="flex items-center gap-2 border-t border-border px-2 py-1.5">
        <Show when={err()}>
          <span class="min-w-0 flex-1 text-xs text-destructive">{err()}</span>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto h-7 text-muted-foreground"
          onClick={() => void respondQuestion(props.q.request_id, "reject").then(props.onDone)}
        >
          {t("question.dismiss")}
        </Button>
        <Show when={groups.length > 0}>
          <Button size="sm" class="h-7" onClick={() => void submit()}>
            {t("question.reply")}
          </Button>
        </Show>
      </div>
    </div>
  );
}

function sessionModel(v: SessionView | undefined): string | undefined {
  const turns = v?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const assistant = turns[i]!.assistant;
    for (let j = assistant.length - 1; j >= 0; j--) {
      if (assistant[j]?.model) return assistant[j]!.model;
    }
  }
  return undefined;
}

function splitModel(id: string): { providerID: string; modelID: string } | undefined {
  const i = id.indexOf("/");
  if (i <= 0) return undefined;
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

/**
 * A header panel toggle: icon button, quiet at rest, filled while its panel is
 * open.
 *
 * Five of these sit in one row — search, terminal, files, replay, tools — and
 * each had the same class string written out again with the selected state
 * interpolated, so adding a sixth meant copying a ternary. None of them drew a
 * focus ring either, which left tabbing across the header moving an invisible
 * cursor past five controls.
 *
 * `expanded` and `pressed` are separate because the search button answers
 * `aria-expanded` (it reveals a field) while the rest answer `aria-pressed`
 * (they toggle a surface that stays in the layout).
 */
function PanelToggle(props: {
  label: string;
  on: boolean;
  expanded?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="icon"
      class={props.on ? "bg-secondary text-foreground" : undefined}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function LoadingTranscript() {
  return (
    <div class="mx-auto w-full max-w-3xl space-y-4 px-5 py-8">
      <div class="ml-auto h-10 w-2/3 animate-pulse rounded-2xl bg-secondary/80" />
      <div class="h-4 w-5/6 animate-pulse rounded bg-secondary/50" />
      <div class="h-4 w-2/3 animate-pulse rounded bg-secondary/40" />
    </div>
  );
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

/** Ctrl on a PC, ⌘ on a Mac. The tooltip used to say "Ctrl+F" on every platform. */
function findKey(): string {
  return shellPlatform() === "macos" ? "⌘F" : "Ctrl+F";
}

const MCP_STATUS: Record<McpServerStatus["status"], MessageKey> = {
  connected: "mcp.status.connected",
  disabled: "mcp.status.disabled",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
};

function mcpDot(status: McpServerStatus["status"]): string {
  if (status === "connected") return "bg-status-active";
  if (status === "failed" || status === "needs_client_registration") return "bg-status-error";
  if (status === "needs_auth") return "bg-status-pending";
  return "bg-muted-foreground/40";
}

/** How a file changed. The wire values are `add`/`modify`/`delete`; these are labels. */
function changeWord(change: string): string {
  if (change === "add") return t("file.added");
  if (change === "delete") return t("file.deleted");
  return t("file.edited");
}

function ContextRing(props: { percent: number | null }) {
  const length = 2 * Math.PI * 6;
  // Read props inside JSX. A const captured on first run stays at 0, because
  // the context window arrives after the transcript.
  const tone = () =>
    props.percent == null
      ? "text-muted-foreground"
      : props.percent >= 90
        ? "text-destructive"
        : props.percent >= 75
          ? "text-status-cancelled"
          : "text-foreground";
  return (
    <svg viewBox="0 0 16 16" class={`size-4 ${tone()}`} aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" class="stroke-border" stroke-width="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray={`${(Math.max(0, Math.min(100, props.percent ?? 0)) / 100) * length} ${length}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** A filled bar reads faster than the ring once the number is spelled out. */
function ContextBar(props: { percent: number | null }) {
  const width = () => `${Math.max(0, Math.min(100, props.percent ?? 0))}%`;
  const tone = () =>
    props.percent == null
      ? "bg-border"
      : props.percent >= 90
        ? "bg-destructive"
        : props.percent >= 75
          ? "bg-status-cancelled"
          : "bg-foreground";
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div class={`h-full rounded-full transition-[width] ${tone()}`} style={{ width: width() }} />
    </div>
  );
}

/** Label / value row in the session details panel. */
/**
 * A label on the left, a value on the right. `value` is an element rather than
 * a string because the status is a dot with a word beside it, not a word — and
 * because a value this card shows has to be allowed to truncate rather than
 * push the label off the row: a model id is longer than the panel is wide.
 */
function InfoRow(props: {
  label: string;
  value: JSX.Element;
  mono?: boolean;
  tone?: string;
  title?: string;
}) {
  return (
    <div class="flex items-baseline justify-between gap-4 py-1">
      <span class="shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <span
        class={`min-w-0 truncate text-right text-xs tabular-nums ${props.mono ? "font-mono" : ""} ${props.tone ?? "text-foreground"}`}
        title={props.title}
      >
        {props.value}
      </span>
    </div>
  );
}

/** A band of related rows. The rule above it is what groups the card. */
function InfoGroup(props: { label: string; children: JSX.Element }) {
  return (
    <section class="mt-2.5 border-t border-border pt-2.5">
      <div class="mb-0.5 text-2xs tracking-wide text-muted-foreground/70">{props.label}</div>
      <div class="divide-y divide-border/60">{props.children}</div>
    </section>
  );
}

/** A status, as the rest of the app draws one: a dot and the word beside it. */
function StatusValue(props: { status: string }) {
  const key = () => STATUS_LABEL[props.status];
  const dot = () => STATUS_DOT[props.status] ?? "bg-status-pending";
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class={`size-1.5 shrink-0 rounded-full ${dot()}`} />
      <span class="truncate">{key() ? t(key()!) : props.status}</span>
    </span>
  );
}

/**
 * The context ring, made into the entry point for everything about the session
 * that is not the transcript: context use, token breakdown, and cost. Cost
 * used to sit in the header as bare text where it read as clutter next to the
 * window caption; here it has room to be a real number.
 */
function SessionInfo(props: {
  id: string;
  totals: SessionView["totals"];
  context: { total: number; percent: number | null } | undefined;
  model: string;
  backend: string;
  status: string;
  workspace?: string;
}) {
  const contextLimit = () => {
    if (!props.context || props.context.percent == null || props.context.total <= 0) return null;
    return Math.round(props.context.total / (props.context.percent / 100));
  };
  const [idCopied, setIdCopied] = createSignal(false);
  const copyId = async () => {
    const mine = ++copyIdToken;
    clearTimeout(copyIdTimer);
    if (!(await copyText(props.id))) return;
    if (mine !== copyIdToken) return;
    setIdCopied(true);
    copyIdTimer = setTimeout(() => setIdCopied(false), 2000);
  };
  let copyIdToken = 0;
  let copyIdTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The id split at its backend prefix.
   *
   * The prefix is not decoration — the service routes a session back to its
   * backend by reading `casfId.split(":")[0]`, and an ACP id carries the agent's
   * name in a second segment, so dropping only the first would make the rest
   * more ambiguous, not less. A field labelled "session ID" that showed
   * something other than the id would not survive being copied. What is
   * genuinely redundant is the row above already naming the backend, so the
   * prefix is dimmed instead of removed.
   */
  const idParts = () => {
    const at = props.id.indexOf(":");
    return at === -1 ? [props.id, ""] : [props.id.slice(0, at + 1), props.id.slice(at + 1)];
  };

  return (
    <div class="w-72">
      <div class="mb-2 text-sm font-medium">{t("info.session")}</div>

      <div class="rounded-md border border-border bg-secondary/40 p-2.5">
        <div class="flex items-baseline justify-between">
          <span class="text-xs text-muted-foreground">{t("info.context")}</span>
          <span class="font-mono text-xs tabular-nums text-foreground">
            {props.context
              ? props.context.percent == null
                ? `${num(props.context.total)} tok`
                : `${props.context.percent}%`
              : "—"}
          </span>
        </div>
        <div class="mt-2">
          <ContextBar percent={props.context?.percent ?? null} />
        </div>
        <div class="mt-1.5 flex items-baseline justify-between text-2xs text-muted-foreground">
          <span>
            {props.context ? `${num(props.context.total)} tokens` : t("info.context.none")}
          </span>
          <Show when={contextLimit()}>
            <span class="font-mono">{t("info.context.of", { n: num(contextLimit()!) })}</span>
          </Show>
        </div>
      </div>

      <InfoGroup label={t("info.group.usage")}>
        <InfoRow label={t("info.model")} value={props.model || "—"} mono title={props.model} />
        <InfoRow label={t("info.cost")} value={fmtUsd(props.totals.cost_usd)} mono />
        {/* A cache-read count runs to nine digits. Spelled out it is the
            widest thing in the panel and pushes every other row's decimal out
            of alignment; the exact figure stays on hover. */}
        <InfoRow
          label={t("info.input")}
          value={compactNum(props.totals.input)}
          mono
          title={num(props.totals.input)}
        />
        <InfoRow
          label={t("info.output")}
          value={compactNum(props.totals.output)}
          mono
          title={num(props.totals.output)}
        />
        <Show when={props.totals.reasoning > 0}>
          <InfoRow
            label={t("info.reasoning")}
            value={compactNum(props.totals.reasoning)}
            mono
            title={num(props.totals.reasoning)}
          />
        </Show>
        <Show when={props.totals.cache_read > 0}>
          <InfoRow
            label={t("info.cache_read")}
            value={compactNum(props.totals.cache_read)}
            mono
            title={num(props.totals.cache_read)}
          />
        </Show>
        <InfoRow
          label={t("info.tool_calls")}
          value={`${props.totals.tool_calls}${props.totals.tool_errors ? ` · ${t("info.tool_calls.failed", { n: num(props.totals.tool_errors) })}` : ""}`}
          mono
          tone={props.totals.tool_errors > 0 ? "text-status-error" : undefined}
        />
      </InfoGroup>

      <InfoGroup label={t("info.group.identity")}>
        <InfoRow label={t("info.status")} value={<StatusValue status={props.status} />} />
        <InfoRow label={t("info.backend")} value={backendLabel(props.backend)} />
        <Show when={props.workspace}>
          <InfoRow label={t("info.workspace")} value={props.workspace!} mono title={props.workspace} />
        </Show>
        <InfoRow
          label={t("info.id")}
          value={
            <Button
              type="button"
              variant="quiet"
              size="xs"
              class="h-auto max-w-full px-0 py-0"
              title={props.id}
              aria-label={t("info.id.copy")}
              onClick={() => void copyId()}
            >
              <Icon name={idCopied() ? "check" : "copy"} class="size-3 shrink-0 text-muted-foreground" />
              <span class="truncate">
                <span class="text-muted-foreground">{idParts()[0]}</span>
                {idParts()[1]}
              </span>
            </Button>
          }
          mono
          title={props.id}
        />
      </InfoGroup>
    </div>
  );
}

/** turns a live refresh asks for; a durable event during a reply lands in the last one or two */
const TAIL_TURNS = 3;

/** Newest sequence number for a session, or 0. Covers (session_id, seq), so this is an index probe. */
async function readHead(id: string): Promise<number> {
  const r = await getJson<{ events: { seq: number }[] }>(
    `/events?session_id=${encodeURIComponent(id)}&order=desc&limit=1`,
  );
  return r.events[0]?.seq ?? 0;
}

/**
 * A search result's context. FTS brackets the terms it matched, and splitting
 * on those brackets is what makes a hit findable at a glance — a snippet of
 * transcript prose with no marker on the word the reader searched for is just
 * more text to read.
 */
function Snippet(props: { text: string }) {
  const parts = () => props.text.split(/(\[[^\]]*\])/g).filter(Boolean);
  return (
    <span class="line-clamp-2 text-xs leading-5 text-foreground/85">
      <For each={parts()}>
        {(s) =>
          s.startsWith("[") && s.endsWith("]") ? (
            <mark class="rounded-sm bg-primary/20 px-0.5 text-foreground">{s.slice(1, -1)}</mark>
          ) : (
            s
          )
        }
      </For>
    </span>
  );
}

/**
 * The right side belongs to the window, not to the tab.
 *
 * Both signals used to live inside `SessionDetail`, which `App` renders `keyed`
 * on the session id — every tab click tore them down and built fresh ones.
 * They are the reader's, so they outlive the session.
 */
const [panelOpen, setPanelOpen] = createSignal(readPanelOpen());
const [panelTab, setPanelTab] = createSignal<SidePanelTab>(readPanelTab());
const [paneWorkspace, setPaneWorkspace] = createSignal<PaneWorkspaceState>(readPaneWorkspace());
const paneScrollMemory = new Map<string, { scrollTop: number; pinned: boolean }>();

function updatePaneWorkspace(updater: (prev: PaneWorkspaceState) => PaneWorkspaceState): PaneWorkspaceState {
  const cur = paneWorkspace();
  const next = updater(cur);
  if (next === cur) return cur;
  setPaneWorkspace(next);
  writePaneWorkspace(next);
  return next;
}

/**
 * Open `sessionId` in a new split beside the currently focused pane and
 * navigate to it.
 */
export function openSessionInSplit(sessionId: string, dir: SplitDir = "row"): void {
  updatePaneWorkspace((ws) => splitPane(ws, ws.focusedPaneId, dir, sessionId));
  location.hash = `/session/${encodeURIComponent(sessionId)}`;
}

type StreamEventPayload = {
  session_id?: string;
  type: string;
  data?: { state?: string; partial?: boolean };
};

/**
 * Lightweight live transcript for a non-focused pane in multiplex mode.
 * Shares the in-memory `view-cache` and receives SSE events forwarded from the
 * single `EventSource` owned by `SessionDetail`, so watching four panes in a
 * 2x2 grid still uses only one stream connection.
 */
function PeerSessionTranscript(props: {
  sessionId: string;
  paneId: string;
  sessions: readonly SessionRowSummary[];
  onFocus: () => void;
  onOpenChild: (id: string) => void;
}) {
  const memKey = () => `${props.paneId}:${props.sessionId}`;
  const savedScroll = paneScrollMemory.get(`${props.paneId}:${props.sessionId}`);
  const opening = peekView(props.sessionId);
  const [booting, setBooting] = createSignal(!opening);
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let fetchGen = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  const [view, { refetch, mutate }] = createResource(
    () => props.sessionId,
    (id: string) => {
      const gen = ++fetchGen;
      const path = `/sessions/${encodeURIComponent(id)}/view`;
      const fullNow = forceFull;
      forceFull = false;
      if (fullNow) {
        return getJson<SessionView>(path).then((full) => {
          if (gen === fetchGen) {
            filesKey = filesKeyOf(full);
            rememberView(id, full, filesKey);
          }
          return full;
        });
      }
      const hit = peekView(id);
      if (hit) {
        if (hit.filesKey) filesKey = hit.filesKey;
        return Promise.resolve(hit.view);
      }
      return readViewTail(id, TAIL_TURNS).then(async (tail) => {
        if (gen !== fetchGen) return viewFromTail(tail);
        if (alive) {
          filesKey = tail.files_key;
          mutate(viewFromTail(tail));
        }
        const full = await getJson<SessionView>(path).catch(() => undefined);
        if (gen !== fetchGen || !full) return viewFromTail(tail);
        const keyOf = filesKeyOf(full);
        if (alive) filesKey = keyOf;
        rememberView(id, full, keyOf);
        return full;
      });
    },
    opening ? { initialValue: opening.view } : undefined,
  );

  createEffect(() => {
    if (booting() && (view.state === "ready" || view.state === "errored" || settled(view))) {
      setBooting(false);
    }
  });

  let running: Promise<void> | undefined;
  let nextRefresh: "tail" | "full" | undefined;
  const refreshPeerView = (full = false): Promise<void> => {
    if (running) {
      if (full || !nextRefresh) nextRefresh = full ? "full" : "tail";
      return running;
    }
    running = (async () => {
      let wantFull = full;
      try {
        for (;;) {
          if (!alive) return;
          const current = settled(view);
          if (wantFull || !current) {
            filesKey = undefined;
            forceFull = true;
            await refetch();
            if (!alive) return;
            const fullView = settled(view);
            if (fullView) {
              filesKey = filesKeyOf(fullView);
              rememberView(props.sessionId, fullView, filesKey);
            }
          } else {
            const tail = await readViewTail(props.sessionId, TAIL_TURNS, filesKey);
            if (!alive) return;
            const base = settled(view) ?? current;
            if (tailMatches(base, tail)) {
              filesKey = tail.files_key;
              rememberView(props.sessionId, base, filesKey);
            } else {
              const merged = mergeViewTail(base, tail);
              if (!merged) {
                filesKey = undefined;
                wantFull = true;
                continue;
              }
              filesKey = tail.files_key;
              mutate(merged);
              rememberView(props.sessionId, merged, filesKey);
            }
          }
          if (!nextRefresh) break;
          wantFull = nextRefresh === "full";
          nextRefresh = undefined;
        }
      } catch {
        // Retried on next stream event
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  let scroller: HTMLDivElement | undefined;
  let list: VirtualApi | undefined;
  const [scrollTop, setScrollTop] = createSignal(savedScroll?.scrollTop ?? 0);
  const [viewport, setViewport] = createSignal(0);
  const [pinned, setPinned] = createSignal(savedScroll?.pinned ?? true);
  const [activeTurn, setActiveTurn] = createSignal(0);

  onMount(() => {
    if (peekView(props.sessionId)) {
      queueMicrotask(() => {
        if (alive) void refreshPeerView(false);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
    const onStream = (ev: Event) => {
      const evt = (ev as CustomEvent<StreamEventPayload>).detail;
      if (!evt || evt.session_id !== props.sessionId) return;
      if (evt.type === "turn.assistant" && evt.data?.partial === true) {
        const snap = evt.data as unknown as StreamingSnapshot;
        mutate((v) => {
          if (!v) return v;
          const next = applyStreamingSnapshot(v, snap);
          const held = peekView(props.sessionId);
          if (
            next !== v &&
            held &&
            next.turns.length >= held.view.turns.length &&
            next.turns[0]?.turn_id === held.view.turns[0]?.turn_id
          ) {
            rememberView(props.sessionId, next);
          }
          return next;
        });
        return;
      }
      if (evt.type === "session.rebuilt") rebuilt = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshPeerView(rebuilt);
        rebuilt = false;
      }, 90);
    };
    window.addEventListener("strata-stream-event", onStream);
    onCleanup(() => {
      clearTimeout(timer);
      window.removeEventListener("strata-stream-event", onStream);
    });
  });

  const turns = () => settled(view)?.turns ?? [];
  const entries = createMemo(() => promptEntries(turns()));
  const showNav = () => !booting() && entries().length >= 2;
  const activeEntry = () => (pinned() ? entries().at(-1) : promptAt(entries(), activeTurn()));
  const row = () => props.sessions.find((s) => s.summary.session_id === props.sessionId);
  const peerGenerating = () =>
    Boolean(row()?.busy) ||
    Boolean(settled(view)?.busy) ||
    turns().some((t) => t.assistant.some((a) => a.partial));
  const needsInput = () => Boolean(row()?.needs_input);

  const childOf = (id: string) => {
    const r = props.sessions.find((s) => s.summary.session_id === id);
    if (!r) return undefined;
    return { title: r.title ?? "", status: r.status, busy: r.busy };
  };

  const jumpToLatest = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setPinned(true);
    setActiveTurn(Math.max(0, turns().length - 1));
    paneScrollMemory.set(memKey(), { scrollTop: scroller?.scrollTop ?? 0, pinned: true });
  };

  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={(el) => {
          scroller = el;
          queueMicrotask(() => {
            if (!el) return;
            setViewport(el.clientHeight);
            const remembered = paneScrollMemory.get(memKey());
            if (remembered && !remembered.pinned && remembered.scrollTop > 0) {
              el.scrollTop = remembered.scrollTop;
              setScrollTop(remembered.scrollTop);
            }
          });
        }}
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          setScrollTop(el.scrollTop);
          setViewport(el.clientHeight);
          setPinned(isPinned);
          setActiveTurn(list?.indexAtTop() ?? 0);
          paneScrollMemory.set(memKey(), { scrollTop: el.scrollTop, pinned: isPinned });
        }}
      >
        <div
          class={
            showNav()
              ? "mx-auto w-full max-w-3xl py-4 pl-11 pr-5"
              : "mx-auto w-full max-w-3xl px-5 py-4"
          }
        >
          <Show when={!booting()} fallback={<LoadingTranscript />}>
            <Show
              when={turns().length > 0}
              fallback={
                <div class="flex justify-center">
                  <EmptyState
                    icon="spark"
                    title={t("session.empty")}
                    description={t("session.empty_hint")}
                    class="py-10"
                  />
                </div>
              }
            >
              <Virtual
                items={turns()}
                id={(turn) => turn.turn_id}
                estimate={100}
                gap={32}
                scrollTop={scrollTop()}
                viewport={viewport()}
                scroller={() => scroller}
                api={(a) => {
                  list = a;
                  setActiveTurn(a.indexAtTop());
                }}
              >
                {(turn) => (
                  <div data-turn-id={turn().turn_id}>
                    <TurnBlock
                      turn={turn()}
                      awaiting={() => false}
                      childOf={childOf}
                      onOpenChild={props.onOpenChild}
                    />
                  </div>
                )}
              </Virtual>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={showNav()}>
        <PromptNavigator
          entries={entries()}
          activeId={activeEntry()?.turnId}
          onSelect={(turnId) => {
            const idx = turns().findIndex((x) => x.turn_id === turnId);
            if (idx >= 0) {
              setPinned(false);
              list?.scrollToIndex(idx, "start");
              setActiveTurn(idx);
            }
          }}
        />
      </Show>

      <Show when={!booting() && !pinned() && turns().length > 0}>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          class="surface-popover absolute bottom-10 left-1/2 z-20 h-auto -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 shadow-md"
          onClick={jumpToLatest}
        >
          {t("nav.latest")}
        </Button>
      </Show>

      <Show when={settled(view)?.plan && planVisible(settled(view)!.plan, peerGenerating())}>
        <div class="shrink-0 border-t border-border px-3 py-1.5">
          <PlanStrip
            sessionId={props.sessionId}
            plan={settled(view)!.plan!}
            generating={peerGenerating()}
          />
        </div>
      </Show>

      <Show when={needsInput()}>
        <div
          class="shrink-0 border-t border-border bg-secondary/40 px-3 py-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            class="w-full justify-start gap-2 border-status-pending/40 bg-status-pending/10 text-foreground hover:bg-status-pending/20"
            onClick={() => props.onFocus()}
          >
            <span class="size-1.5 shrink-0 rounded-full bg-status-pending" />
            <span class="truncate text-xs">{t("pane.needs_input.banner")}</span>
          </Button>
        </div>
      </Show>
    </div>
  );
}

export function SessionDetail(props: {
  id: string;
  sessions: SessionRowSummary[];
}) {
  createEffect(() => {
    const id = props.id;
    updatePaneWorkspace((ws) => assignSessionToWorkspace(ws, id));
  });

  const candidateSessionIds = () => props.sessions.map((s) => s.summary.session_id);

  const navigatePaneSession = (sessionId: string | null) => {
    if (sessionId && sessionId !== props.id) {
      location.hash = `/session/${encodeURIComponent(sessionId)}`;
    }
  };

  const handleSelectPreset = (preset: LayoutPreset) => {
    const next = updatePaneWorkspace((ws) =>
      applyLayoutPreset(ws, preset, props.id, candidateSessionIds()),
    );
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleSplitPane = (paneId: string, dir: SplitDir) => {
    // Seed the new split with the next session not already on screen, or leave
    // the pane empty for the picker.
    const usedIds = new Set<string>();
    const collectUsed = (n: PaneWorkspaceState["root"]) => {
      if (n.kind === "leaf") {
        if (n.sessionId) usedIds.add(n.sessionId);
      } else {
        collectUsed(n.a);
        collectUsed(n.b);
      }
    };
    collectUsed(paneWorkspace().root);
    usedIds.add(props.id);
    const nextCandidate = candidateSessionIds().find((sid) => !usedIds.has(sid)) ?? null;
    const next = updatePaneWorkspace((ws) => splitPane(ws, paneId, dir, nextCandidate));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleFocusPane = (paneId: string, sessionId: string | null) => {
    updatePaneWorkspace((ws) => focusPane(ws, paneId));
    navigatePaneSession(sessionId);
  };

  const handleSelectPaneSession = (paneId: string, sessionId: string) => {
    updatePaneWorkspace((ws) => setPaneSession(ws, paneId, sessionId));
    navigatePaneSession(sessionId);
  };

  const handleClosePane = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => closePane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleToggleZoom = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => toggleZoomPane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleResizeSplit = (splitId: string, ratio: number) => {
    updatePaneWorkspace((ws) => resizeSplit(ws, splitId, ratio));
  };
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [traceOn, setTraceOn] = createSignal(false);
  const [traceBlock, setTraceBlock] = createSignal<TraceBlock | null>(null);
  /** which file the reader opened in the rail, null for the plain list */
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  /**
   * The rail's width belongs to the reader, not to the tab.
   *
   * It was `w-72` on one tab and `min(600px, 48vw)` on the rest, so every tab
   * click resized the panel and re-wrapped the transcript beside it. Only the
   * reader moves it now — the drag edge below, or the arrow keys — and the
   * window only ever clamps it.
   */
  const [railWidth, setRailWidth] = createSignal(readRailWidth(window.innerWidth));
  const resizeRail = (px: number, remember: boolean) => {
    const next = clampRailWidth(px, window.innerWidth);
    setRailWidth(next);
    if (remember) writeRailWidth(next);
  };
  const startRailDrag = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const from = e.clientX;
    const was = railWidth();
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => resizeRail(was + (from - ev.clientX), false);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      writeRailWidth(railWidth());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };
  const [terminalOn, setTerminalOn] = createSignal(false);
  const [reviewSource, setReviewSource] = createSignal<"session" | "git">("session");
  const [reviewLayout, setReviewLayout] = createSignal<"unified" | "split">("unified");
  const opening = peekView(props.id);
  const [booting, setBooting] = createSignal(!opening);
  /** the background re-import that lands after the stored view is already up */
  const [importing, setImporting] = createSignal(true);
  const [modelTouched, setModelTouched] = createSignal(false);
  // The files list key travels with the cached view so a warm open can leave
  // an unchanged list off the wire. forceFull skips the cache for one fetch.
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let fetchGen = 0;
  let viewAlive = true;
  /** Consecutive automatic reload attempts after a failed one. */
  let retries = 0;
  onCleanup(() => {
    viewAlive = false;
  });
  const [view, { refetch, mutate }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    (key: { id: string; pos: number | null }) => {
      const gen = ++fetchGen;
      const path = `/sessions/${encodeURIComponent(key.id)}/view`;
      // Consume the flag even when this fetch is a replay, so leaving the
      // replay does not turn the next live open into a full download.
      const fullNow = forceFull;
      forceFull = false;
      if (key.pos !== null) return getJson<SessionView>(`${path}?until_seq=${key.pos}`);
      if (fullNow) {
        return getJson<SessionView>(path).then((full) => {
          if (gen === fetchGen) {
            filesKey = filesKeyOf(full);
            rememberView(key.id, full, filesKey);
          }
          return full;
        });
      }
      const hit = peekView(key.id);
      if (hit) {
        if (hit.filesKey) filesKey = hit.filesKey;
        return Promise.resolve(hit.view);
      }
      // Paint the tail, then replace it with the settled view. The preview is
      // not cached: storing it would make the next open a transcript with no history.
      return readViewTail(key.id, TAIL_TURNS).then(async (tail) => {
        if (gen !== fetchGen) return viewFromTail(tail);
        if (viewAlive) {
          filesKey = tail.files_key;
          mutate(viewFromTail(tail));
        }
        const full = await getJson<SessionView>(path).catch(() => undefined);
        if (gen !== fetchGen || !full) return viewFromTail(tail);
        const keyOf = filesKeyOf(full);
        if (viewAlive) filesKey = keyOf;
        rememberView(key.id, full, keyOf);
        return full;
      });
    },
    opening ? { initialValue: opening.view } : undefined,
  );
  const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);
  // Live machine state, not part of the record: it shows only while the
  // session's OpenCode backend is connected, and follows a checkout made
  // outside strata once the window comes back.
  const [vcs, { refetch: refetchVcs }] = createResource(
    () => props.id,
    (id) => readVcs(id).catch(() => undefined),
  );
  const [asks, { refetch: refetchAsks }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [hiddenAsks, setHiddenAsks] = createSignal<ReadonlySet<string>>(new Set());
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: (PendingQuestion & { session_id: string })[] }>(
        "/questions",
      );
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [draft, setDraft] = createSignal(readDraft(props.id));
  const [queued, setQueued] = createSignal<Outgoing[]>([]);
  const [histIndex, setHistIndex] = createSignal(-1);
  const [histSaved, setHistSaved] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");
  const [pendingSend, setPendingSend] = createSignal(false);
  const [options, { refetch: refetchOptions }] = createResource(() =>
    getJson<OptionsResponse>("/options"),
  );
  const [modelSel, setModelSel] = createSignal("");
  const [agentSel, setAgentSel] = createSignal("");
  const [variantSel, setVariantSel] = createSignal("");
  const [caps, { refetch: refetchCaps }] = createResource(
    () => props.id,
    (id) => readCapabilities(id).catch(() => undefined),
  );
  const opencode = () => caps()?.extension === "opencode";
  const [lspServers] = createResource(
    () => (opencode() ? props.id : undefined),
    (id) => readLsp(id).catch(() => undefined),
  );
  const reviewKey = () => {
    if (!opencode()) return false as const;
    return { id: props.id, source: reviewSource() };
  };
  const [reviewDiff] = createResource(reviewKey, (key) =>
    key.source === "git" ? readVcsDiff(key.id, "git") : readSessionDiff(key.id),
  );
  const [commands, { refetch: refetchCommands }] = createResource(
    () => (caps()?.commands && opencode() ? props.id : undefined),
    (id) => readCommands(id).catch(() => undefined),
  );
  const [picked, setPicked] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [trigger, setTrigger] = createSignal<Trigger>();
  /** the trigger start the user closed with Escape; it stays closed until they type elsewhere */
  const [dismissedAt, setDismissedAt] = createSignal<number>();
  /** tagged with what they were found for, so a list never shows under the other trigger */
  const [menuList, setMenuList] = createSignal<{ kind: Trigger["kind"]; query: string; items: MenuItem[] }>({
    kind: "file",
    query: "",
    items: [],
  });
  const [menuActive, setMenuActive] = createSignal(0);
  const [attachErr, setAttachErr] = createSignal("");
  /** set when a send fails, so queued follow-ups wait for the reader instead of going out without it */
  const [queuePaused, setQueuePaused] = createSignal(false);
  /** turn the next send should revert first, set when the reader edits a message */
  const [editTurnId, setEditTurnId] = createSignal<string>();
  const menuId = createUniqueId();
  let draftEl: HTMLTextAreaElement | undefined;
  const citeLine = (note: string) => {
    setDraft((cur) => (cur && !cur.endsWith("\n") ? `${cur}\n${note}` : `${cur}${note}`));
    draftEl?.focus();
  };
  let fileInput: HTMLInputElement | undefined;
  let scroller: HTMLDivElement | undefined;
  // Virtual needs these every frame it decides what to keep mounted. The
  // scroller owns the scroll, so the offset is read back out of it rather than
  // re-derived here.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  // Whether the reader is following the tail. It is a signal rather than a
  // plain flag because the virtual list has to consult it while applying
  // measurements, which happens outside any render pass here.
  const [pinned, setPinned] = createSignal(true);
  /** The turn at the top of the viewport — which prompt the outline lights up. */
  const [activeTurn, setActiveTurn] = createSignal(0);

  // Full-text search inside the open session. This is not a convenience: the
  // transcript is windowed, so the reader's own Ctrl+F only sees the rows that
  // happen to be mounted. Searching has to go to the index to reach the rest.
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hitAt, setHitAt] = createSignal(0);
  const [probe, setProbe] = createSignal("");
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const [toolsReady, setToolsReady] = createSignal(false);
  const [mcpServers, setMcpServers] = createSignal<[string, McpServerStatus][]>([]);
  const [mcpBusy, setMcpBusy] = createSignal<string>();
  const [mcpNote, setMcpNote] = createSignal<{ name: string; text: string }>();
  let searchEl: HTMLInputElement | undefined;
  let resultsEl: HTMLUListElement | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let list: VirtualApi | undefined;

  const onQuery = (v: string) => {
    setQuery(v);
    clearTimeout(probeTimer);
    // Every keystroke that reached the index would be a round trip; the index
    // is fast but the network round trip is not, and the answer only has to be
    // right by the time the reader stops typing.
    probeTimer = setTimeout(() => setProbe(v.trim()), 180);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setProbe("");
    setHitAt(0);
  };

  const loadTools = async () => {
    try {
      const mcp = await readMcp(props.id);
      setMcpServers(Object.entries(mcp ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : t("err.network"));
    } finally {
      setToolsReady(true);
    }
  };

  const toggleTools = () => {
    if (toolsOpen()) {
      setToolsOpen(false);
      return;
    }
    closeSearch();
    setMcpNote(undefined);
    setToolsReady(false);
    setToolsOpen(true);
    void loadTools();
  };

  createEffect(() => {
    if (opencode()) void loadTools();
  });

  const toggleMcp = async (name: string, action: "connect" | "disconnect") => {
    const before = mcpServers().find(([n]) => n === name)?.[1].status;
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      if (action === "connect") await connectMcp(props.id, name);
      else await disconnectMcp(props.id, name);
      await loadTools();
      const after = mcpServers().find(([n]) => n === name)?.[1].status;
      if (after === before) setMcpNote({ name, text: t("mcp.unchanged") });
    } catch (err) {
      setMcpNote({ name, text: err instanceof Error ? err.message : t("err.network") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  const [mcpKind, setMcpKind] = createSignal<"command" | "url">("url");
  const [mcpName, setMcpName] = createSignal("");
  const [mcpValue, setMcpValue] = createSignal("");
  const [mcpAdding, setMcpAdding] = createSignal(false);
  const [mcpAddErr, setMcpAddErr] = createSignal("");

  const submitMcp = async (e: Event) => {
    e.preventDefault();
    const name = mcpName().trim();
    const value = mcpValue().trim();
    if (!name || !value || mcpAdding()) return;
    setMcpAdding(true);
    setMcpAddErr("");
    try {
      await addMcp(props.id, mcpKind() === "command" ? { name, command: value } : { name, url: value });
      setMcpName("");
      setMcpValue("");
      await loadTools();
    } catch (err) {
      const text = err instanceof Error ? err.message : t("err.network");
      setMcpAddErr(value.length >= 8 && text.includes(value) ? t("mcp.add.failed") : text);
    } finally {
      setMcpAdding(false);
    }
  };

  const [mcpAuth, setMcpAuth] = createSignal<{ name: string; url: string }>();
  const [mcpCode, setMcpCode] = createSignal("");
  let mcpAuthWait: AbortController | undefined;
  onCleanup(() => mcpAuthWait?.abort());

  const cancelMcpAuth = () => {
    mcpAuthWait?.abort();
    mcpAuthWait = undefined;
    setMcpAuth(undefined);
    setMcpCode("");
  };

  const beginMcpAuth = async (name: string) => {
    if (mcpBusy()) return;
    cancelMcpAuth();
    mcpAuthWait = new AbortController();
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      const started = await beginMcpLogin(props.id, name, mcpAuthWait.signal);
      if ("url" in started && (started.url.startsWith("https://") || started.url.startsWith("http://"))) {
        setMcpAuth({ name, url: started.url });
      } else {
        await loadTools();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const text = err instanceof Error ? err.message : t("mcp.auth.failed");
      setMcpNote({ name, text: text || t("mcp.auth.failed") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  const finishMcpAuth = async (name: string) => {
    const code = mcpCode().trim();
    if (!code || mcpBusy()) return;
    mcpAuthWait?.abort();
    mcpAuthWait = new AbortController();
    setMcpBusy(name);
    setMcpNote(undefined);
    try {
      await finishMcpLogin(props.id, name, code, mcpAuthWait.signal);
      setMcpCode("");
      setMcpAuth(undefined);
      await loadTools();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const text = err instanceof Error ? err.message : t("mcp.auth.failed");
      setMcpNote({ name, text: code.length >= 8 && text.includes(code) ? t("mcp.auth.failed") : text || t("mcp.auth.failed") });
    } finally {
      setMcpBusy(undefined);
    }
  };

  const [result] = createResource(
    () => (searchOpen() && probe() ? { id: props.id, q: probe() } : null),
    ({ id, q }) => searchSession(id, q),
  );
  const hits = () => result()?.hits;

  /**
 * Where a hit lives: a tool result carries no turn of its own — the projector
 * binds it to one through the call that produced it — so a match on tool output
 * is traced back through that call. The transcript in hand already holds that
 * mapping, so resolving costs nothing and needs no second request.
 */
const turnIndexOf = (h: SearchHit): number => {
    const turns = settled(view)?.turns;
    if (!turns) return -1;
    if (h.turn_id) return turns.findIndex((t) => t.turn_id === h.turn_id);
    if (h.call_id) return turns.findIndex((t) => t.tool_calls.some((c) => c.call_id === h.call_id));
    return -1;
  };

  /**
   * One jump target per turn, and only turns a hit can actually be walked to.
   * The index answers in relevance order, which is no order at all to a reader:
   * the first few turns for one term came back 97, 125, 949, 83, 1087. Stepping
   * through matches is a walk down a conversation, so they are sorted into it.
   */
  const targets = createMemo(() => {
    const seen = new Set<string>();
    const out: { hit: SearchHit; at: number }[] = [];
    for (const h of hits() ?? []) {
      const at = turnIndexOf(h);
      if (at < 0) continue;
      const k = settled(view)?.turns[at]?.turn_id ?? `#${h.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ hit: h, at });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.hit);
  });

  const goTo = (h: SearchHit | undefined) => {
    const i = h ? turnIndexOf(h) : -1;
    if (i >= 0) list?.scrollToIndex(i);
  };

  /** Turns are addressed by an opaque id, so a result has to say which one it is. */
  const turnNumber = (h: SearchHit) => turnIndexOf(h) + 1;

  const step = (delta: number) => {
    const all = targets();
    if (!all.length) return;
    const next = Math.max(0, Math.min(all.length - 1, hitAt() + delta));
    setHitAt(next);
    goTo(all[next]);
  };

  const openSearch = (keep?: string) => {
    setToolsOpen(false);
    setSearchOpen(true);
    if (keep) onQuery(keep);
    queueMicrotask(() => searchEl?.focus());
  };

  // Stepping through matches moves the selection much faster than a list this
  // long scrolls on its own, so the active row is pulled into view. Without
  // this the counter reads "26/26" above a list still showing the first four.
  createEffect(() => {
    const at = hitAt();
    resultsEl?.querySelector(`[data-hit="${at}"]`)?.scrollIntoView({ block: "nearest" });
  });

  createEffect(() => {
    const agents = settled(options)?.agents ?? [];
    if (!agentSel() && agents[0]) setAgentSel(agents[0].name);
  });

  createEffect(() => {
    if (modelTouched()) return;
    const inherited = sessionModel(settled(view));
    if (inherited) {
      setModelSel(inherited);
      return;
    }
    if (booting() || !settled(view)) return;
    const models = settled(options)?.models ?? [];
    if (models[0]) setModelSel(`${models[0].providerID}/${models[0].modelID}`);
  });

  const selectedModel = () =>
    settled(options)?.models.find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  // empty model means "server default"; still offer that leading model's efforts
  const effortModel = () =>
    selectedModel() ?? settled(options)?.models.find((m) => (m.variants?.length ?? 0) > 0);
  const modelOptions = () => {
    const models = settled(options)?.models ?? [];
    const known = new Set(models.map((m) => `${m.providerID}/${m.modelID}`));
    // A session can name a model the server no longer lists. Keep it selectable
    // rather than silently snapping the composer to something else.
    const stale =
      modelSel() && !known.has(modelSel())
        ? [
            {
              value: modelSel(),
              label: modelSel().slice(modelSel().indexOf("/") + 1),
              group: "Unavailable",
            },
          ]
        : [];
    return [
      ...stale,
      ...models.map((m) => ({
        value: `${m.providerID}/${m.modelID}`,
        label: m.modelID,
        group: m.providerID,
      })),
    ];
  };
  const generating = () =>
    pendingSend() ||
    !!settled(view)?.busy ||
    !!settled(view)?.turns.some((t) => t.assistant.some((a) => a.partial));

  /** One outline row per real prompt, rebuilt from the view already in hand. */
  const entries = createMemo(() => promptEntries(settled(view)?.turns ?? []));
  const showNav = () => !booting() && replayPos() === null && entries().length >= 2;
  /** Following the tail means the active prompt is the last one, whatever row is on top. */
  const activeEntry = () => (pinned() ? entries().at(-1) : promptAt(entries(), activeTurn()));

  let jumpSettleGen = 0;
  const jumpToTurn = (turnId: string) => {
    const i = settled(view)?.turns.findIndex((t) => t.turn_id === turnId) ?? -1;
    if (i < 0) return;
    // A jump is the reader leaving the tail — same bargain scrollToIndex makes.
    setPinned(false);
    list?.scrollToIndex(i, "start");
    setActiveTurn(i);
    // Rows land on estimated heights; once neighbours mount and measure, the
    // target drifts. Re-anchor to the row's real box for a few frames, holding
    // the same gap a fresh jump gets rather than the top edge itself.
    //
    // Two failures live here, and they need different answers. The row can be
    // mounted and sitting in the wrong place, which is drift and one subtraction
    // fixes. Or it can be not mounted at all, which is what actually happens on
    // a real jump: `scrollToIndex` writes `scrollTop`, the window is recomputed
    // from the parent's mirrored signal, and until that round trip lands the row
    // is not in the document. Giving up on that — the old code returned on the
    // first missing row, having spent none of its eight tries — left the reader
    // somewhere else entirely, with a nav tick showing the jump they asked for
    // and no evidence of it on screen.
    const gen = ++jumpSettleGen;
    let tries = 0;
    let waiting = 0;
    const settle = () => {
      if (gen !== jumpSettleGen) return;
      const el = scroller;
      if (!el) return;
      const row = el.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
      if (!(row instanceof HTMLElement)) {
        // Not in the document yet. Keep looking: this is the window catching up
        // with the scroll we just asked for, and it is measured in frames.
        if (++waiting > 60) return;
        requestAnimationFrame(settle);
        return;
      }
      const drift = row.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_GAP;
      if (Math.abs(drift) <= 4) return;
      if (tries >= 8) return;
      tries += 1;
      el.scrollTop += drift;
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  const jumpToLatest = () => {
    jumpSettleGen++;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setPinned(true);
    setActiveTurn(Math.max(0, (settled(view)?.turns.length ?? 1) - 1));
  };

  /**
   * The prompt has been handed over but the agent has not produced a thing
   * yet. That gap is a round trip through the backend, and until it closes the
   * transcript is a column of nothing below the question just asked — which
   * reads as a hang rather than as work. The turn itself may not exist yet
   * either, so the answer is "is the newest turn still silent", not a fixed row.
   */
  const lastSilentTurn = createMemo(() => {
    if (!generating()) return undefined;
    const turns = settled(view)?.turns;
    const last = turns?.[turns.length - 1];
    if (last && (last.assistant.length > 0 || last.tool_calls.length > 0)) return undefined;
    return last;
  });

  /**
   * The prompt the reader just sent and the backend has not echoed back.
   *
   * Everything before this point was a round trip with an empty column in the
   * middle of it: POST, the agent's SDK, its event stream, SSE back, and a
   * second request for the tail. `turns()` puts the sentence on screen at the
   * instant Enter is pressed and drops it the moment the store's turn count
   * passes the baseline `deliver` recorded, so the real one replaces it rather
   * than joining it.
   */
  const [echo, setEcho] = createSignal<PendingEcho>();
  const turns = createMemo(() => withEcho(settled(view)?.turns ?? [], echo()));

  // A durable event during a reply only moves the last turns, and the whole
  // view of a long session is megabytes. A rebuild, a replay, or a tail that no
  // longer lines up goes back to the full view. Every view load goes through
  // here one at a time, and waits out a fetch already in flight: mutate() does
  // not cancel that fetch, so a tail laid down first would be replaced by the
  // older full view and leave the files list behind the key the server holds.
  let running: Promise<void> | undefined;
  let nextRefresh: "tail" | "full" | undefined;
  const waitWhileLoading = () =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (!viewAlive || !view.loading) resolve();
        else setTimeout(tick, 16);
      };
      tick();
    });
  /** settles once the view reflects this request, queued behind a running one or not */
  const refreshView = (full = false): Promise<void> => {
    if (replayPos() !== null) return Promise.resolve();
    if (running) {
      if (full || !nextRefresh) nextRefresh = full ? "full" : "tail";
      return running;
    }
    running = loadView(full);
    return running;
  };
  const loadView = async (full: boolean): Promise<void> => {
    let wantFull = full;
    try {
      for (;;) {
        if (!viewAlive || replayPos() !== null) return;
        if (view.loading) {
          if (wantFull) nextRefresh = "full";
          else if (!nextRefresh) nextRefresh = "tail";
          await waitWhileLoading();
          if (!viewAlive) return;
          if (!nextRefresh) break;
          wantFull = nextRefresh === "full";
          nextRefresh = undefined;
          continue;
        }
        const current = settled(view);
        if (wantFull || !current) {
          if (replayPos() !== null) return;
          filesKey = undefined;
          forceFull = true;
          await refetch();
          if (!viewAlive || replayPos() !== null) return;
          const fullView = settled(view);
          if (fullView) {
            filesKey = filesKeyOf(fullView);
            rememberView(props.id, fullView, filesKey);
          }
        } else {
          const tail = await readViewTail(props.id, TAIL_TURNS, filesKey);
          if (!viewAlive || replayPos() !== null) return;
          if (view.loading) {
            nextRefresh = nextRefresh ?? "tail";
            continue;
          }
          const base = settled(view) ?? current;
          if (tailMatches(base, tail)) {
            filesKey = tail.files_key;
            rememberView(props.id, base, filesKey);
          } else {
            const merged = mergeViewTail(base, tail);
            if (!merged) {
              filesKey = undefined;
              wantFull = true;
              continue;
            }
            filesKey = tail.files_key;
            mutate(merged);
            rememberView(props.id, merged, filesKey);
          }
        }
        if (!nextRefresh) break;
        wantFull = nextRefresh === "full";
        nextRefresh = undefined;
      }
    } catch {
      // the next event or the head poll asks again
    } finally {
      running = undefined;
      if (nextRefresh) {
        const again = nextRefresh === "full";
        nextRefresh = undefined;
        queueMicrotask(() => void refreshView(again));
      }
    }
  };

  createEffect(() => writeDraft(props.id, draft()));

  // When focus switches between panes (or sidebar sessions) without unmounting
  // `SessionDetail`, swap per-session transient state and paint any cached view
  // synchronously so other panes in the split tree stay mounted undisturbed.
  let activeSessionId = props.id;
  createEffect(() => {
    const id = props.id;
    if (id === activeSessionId) return;
    activeSessionId = id;
    const hit = peekView(id);
    filesKey = hit?.filesKey;
    forceFull = false;
    retries = 0;
    setBooting(!hit);
    setImporting(!hit);
    if (hit) mutate(hit.view);
    setReplayPos(null);
    setTraceOn(false);
    setTraceBlock(null);
    setOpenFile(null);
    setHiddenAsks(new Set<string>());
    setDraft(readDraft(id));
    setQueued([]);
    setHistIndex(-1);
    setHistSaved("");
    setSendErr("");
    setPendingSend(false);
    setEcho(undefined);
    setStopping(false);
    setStopped(false);
    setAbortAccepted(false);
    setModelTouched(false);
    setModelSel("");
    setPicked([]);
    setAttachments([]);
    setAttachErr("");
    setQueuePaused(false);
    setEditTurnId(undefined);
    closeSearch();
    setToolsOpen(false);
    queueMicrotask(autogrow);
    void (async () => {
      const before = await readHead(id).catch(() => undefined);
      await importSession(id).catch(() => {});
      if (props.id !== id) return;
      const after = await readHead(id).catch(() => undefined);
      setImporting(false);
      if (after !== before) void refreshView(true);
      void refetchSeq();
    })();
  });

  // The stored view is already loading — the transcript paints as soon as it
  // lands instead of waiting on a full re-import first. A cached view or a
  // tail preview is enough to leave the boot state; the settled view follows.
  createEffect(() => {
    if (booting() && (view.state === "ready" || view.state === "errored" || settled(view))) setBooting(false);
  });

  /**
   * A failed load used to be permanent.
   *
   * The view resource only refetches when its source changes, so one request
   * that failed — the window opening before the service was listening, a proxy
   * restarting, a laptop waking — left the reader on that message for the rest
   * of the session with no way out but leaving. Try a few times on our own,
   * backing off so a service that is genuinely down is not hammered, then stop
   * and leave the button for them.
   */
  createEffect(() => {
    if (!view.error) {
      retries = 0;
      return;
    }
    if (retries >= 4) return;
    const wait = 500 * 2 ** retries++;
    const timer = setTimeout(() => {
      if (viewAlive) void refetch();
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });

  // A warm open paints the cached view from the resource, then checks the
  // tail. Head equality is not enough while a reply is still streaming.
  createEffect(() => {
    const id = props.id;
    if (replayPos() !== null) return;
    if (!peekView(id)) return;
    queueMicrotask(() => {
      if (viewAlive && replayPos() === null) void refreshView(false);
    });
  });

  onMount(() => {
    if (draft()) queueMicrotask(autogrow);
    // Re-import in the background and only pay for a second full view when it
    // actually moved the session — the head probe is index-only, so this stays
    // cheap even when the import found nothing new.
    void (async () => {
      const before = await readHead(props.id).catch(() => undefined);
      await importSession(props.id).catch(() => {});
      const after = await readHead(props.id).catch(() => undefined);
      setImporting(false);
      if (after !== before) void refreshView(true);
      void refetchSeq();
    })();
    const onConns = () => {
      refetchOptions();
      refetchVcs();
      refetchCaps();
      refetchCommands();
    };
    window.addEventListener("strata-connections", onConns);
    const onFocus = () => refetchVcs();
    window.addEventListener("focus", onFocus);
    // Seed the virtual window's inputs. Without this the list would start with a
    // zero-height viewport and only learn its size on the first scroll, which
    // for a session that opens pinned to the bottom means one wasted pass.
    if (scroller) {
      setScrollTop(scroller.scrollTop);
      setViewport(scroller.clientHeight);
    }
    const poll = setInterval(() => {
      if (replayPos() !== null) return;
      // This is the fallback for a dropped stream message, not the main path —
      // that is /stream, which already collapses a burst into one refetch.
      // Pulling the whole view on a timer meant re-downloading megabytes and
      // rebuilding tens of thousands of nodes every three seconds to discover
      // nothing had moved, and the rebuild is what the scroll stutter was:
      // ~280ms of blocked main thread, three times in any eight seconds of
      // scrolling. Ask for the head instead — a few hundred bytes, index-only —
      // and only pay for the view when the session has actually advanced.
      void readHead(props.id)
        .then((seq) => {
          if (seq === maxSeq()) return;
          void refreshView();
          void refetchSeq();
        })
        .catch(() => {});
    }, 3_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string; partial?: boolean };
        };
        if (evt.session_id && evt.session_id !== props.id) {
          window.dispatchEvent(new CustomEvent("strata-stream-event", { detail: evt }));
        }
        if (evt.session_id === props.id && evt.type === "turn.assistant" && evt.data?.partial === true) {
          if (replayPos() === null) {
            const snap = evt.data as unknown as StreamingSnapshot;
            mutate((v) => {
              if (!v) return v;
              const next = applyStreamingSnapshot(v, snap);
              // Only extend a view we already settled. A tail preview is shorter
              // and must not replace the full transcript in the reader cache.
              const held = peekView(props.id);
              if (
                next !== v &&
                held &&
                next.turns.length >= held.view.turns.length &&
                next.turns[0]?.turn_id === held.view.turns[0]?.turn_id
              ) {
                rememberView(props.id, next);
              }
              return next;
            });
          }
          return;
        }
        if (evt.session_id === props.id && evt.type === "session.status" && evt.data?.state === "idle")
          setPendingSend(false);
        if (evt.session_id === props.id || evt.type === "permission.requested" || evt.type === "question.asked") {
          if (replayPos() === null) {
            if (evt.session_id === props.id && evt.type === "session.rebuilt") rebuilt = true;
            clearTimeout(timer);
            timer = setTimeout(() => {
              void refreshView(rebuilt);
              rebuilt = false;
              refetchAsks();
              refetchQuestions();
              refetchSeq();
            }, 80);
          }
        }
      } catch {
        // service.connected and heartbeats
      }
    };
    onCleanup(() => {
      clearInterval(poll);
      clearTimeout(timer);
      clearTimeout(probeTimer);
      es.close();
      window.removeEventListener("strata-connections", onConns);
      window.removeEventListener("focus", onFocus);
    });
  });

  const respond = async (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => {
    setHiddenAsks((cur) => new Set(cur).add(requestId));
    try {
      await respondPermission(requestId, decision, scope);
    } catch (err) {
      const missing = err instanceof Error && /\b404\b/.test(err.message);
      if (!missing) {
        setHiddenAsks((cur) => {
          const next = new Set(cur);
          next.delete(requestId);
          return next;
        });
        setSendErr(err instanceof Error ? err.message : t("err.network"));
      }
    }
    refetchAsks();
  };

  const openAsks = () => {
    const hidden = hiddenAsks();
    const decided = new Set<string>();
    const finished = new Set<string>();
    for (const turn of settled(view)?.turns ?? []) {
      for (const call of turn.tool_calls) {
        if (call.permission?.request_id && call.permission.decision) decided.add(call.permission.request_id);
        if (call.call_id && call.status !== "pending") finished.add(call.call_id);
      }
    }
    return (settled(asks) ?? []).filter((ask) => {
      if (hidden.has(ask.request_id) || decided.has(ask.request_id)) return false;
      if (ask.call_id && finished.has(ask.call_id)) return false;
      return true;
    });
  };

  const autogrow = () => {
    if (!draftEl) return;
    draftEl.style.height = "auto";
    draftEl.style.height = `${Math.min(draftEl.scrollHeight, 220)}px`;
  };

  const menuItems = () => (menuList().kind === trigger()?.kind ? menuList().items : []);
  /** a search still on its way, or not started, is not "no matches" */
  const menuHint = () => {
    const tr = trigger();
    const list = menuList();
    const stale = !tr || list.kind !== tr.kind || list.query !== tr.query;
    return tr?.kind === "file" && (!tr.query || stale) ? t("composer.menu.search_files") : undefined;
  };
  const menuOpen = () => {
    const tr = trigger();
    if (!tr || tr.start === dismissedAt()) return false;
    return tr.kind === "file" ? opencode() : Array.isArray(commands());
  };

  createEffect(() => {
    const tr = trigger();
    if (!tr || tr.kind !== "command") return;
    const list = matchCommands(commands() ?? [], tr.query).slice(0, 50);
    setMenuList({
      kind: "command",
      query: tr.query,
      items: list.map((c) => ({
        key: c.name,
        value: c.name,
        label: `/${c.name}`,
        detail: c.description,
        badge:
          c.source === "mcp"
            ? t("composer.menu.source.mcp")
            : c.source === "skill"
              ? t("composer.menu.source.skill")
              : undefined,
      })),
    });
    setMenuActive(0);
  });

  let fileSearch: AbortController | undefined;
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const tr = trigger();
    clearTimeout(fileTimer);
    fileSearch?.abort();
    if (!tr || tr.kind !== "file" || !opencode()) return;
    if (!tr.query) {
      setMenuList({ kind: "file", query: "", items: [] });
      return;
    }
    fileTimer = setTimeout(() => {
      const ctl = (fileSearch = new AbortController());
      void findFiles(props.id, tr.query, ctl.signal)
        .then((paths) => {
          if (ctl.signal.aborted) return;
          setMenuList({
            kind: "file",
            query: tr.query,
            items: (paths ?? []).map((p) => {
              const cut = p.lastIndexOf("/");
              return { key: p, value: p, label: p.slice(cut + 1), detail: cut > 0 ? p.slice(0, cut) : undefined };
            }),
          });
          setMenuActive(0);
        })
        .catch(() => {});
    }, 120);
  });
  onCleanup(() => {
    clearTimeout(fileTimer);
    fileSearch?.abort();
  });

  const track = () => {
    const tr = draftEl ? triggerAt(draft(), draftEl.selectionStart ?? 0) : undefined;
    if (tr?.start !== dismissedAt()) setDismissedAt(undefined);
    const cur = trigger();
    // a click or caret key that lands on the same trigger must not reset the active row
    if (cur && tr && cur.kind === tr.kind && cur.start === tr.start && cur.end === tr.end && cur.query === tr.query) return;
    setTrigger(tr);
  };

  const pick = (i: number) => {
    const tr = trigger();
    const item = menuItems()[i];
    if (!tr || !item || !draftEl) return;
    const next = insertPick(draft(), tr, item.value);
    if (tr.kind === "file") setPicked((p) => (p.includes(item.value) ? p : [...p, item.value]));
    setDraft(next.text);
    setTrigger(undefined);
    queueMicrotask(() => {
      autogrow();
      draftEl?.setSelectionRange(next.caret, next.caret);
      draftEl?.focus();
    });
  };

  let attachSeq = 0;
  const addFiles = async (from: ArrayLike<File>) => {
    // a FileList empties once its input is reset or its event is over
    const files = Array.from(from);
    setAttachErr("");
    const full = () => {
      if (attachments().length < MAX_ATTACHMENTS) return false;
      setAttachErr(t("composer.attach.too_many", { n: MAX_ATTACHMENTS }));
      return true;
    };
    for (const file of files) {
      if (full()) return;
      const problem = attachmentProblem(file);
      if (problem) {
        setAttachErr(
          t(problem === "type" ? "composer.attach.bad_type" : "composer.attach.too_big", { name: file.name || "file" }),
        );
        continue;
      }
      let a: Attachment;
      try {
        if (file.type.startsWith("image/") && typeof createImageBitmap === "function") {
          // OpenCode drops an undecodable image without a reply or an idle
          (await createImageBitmap(file)).close();
        }
        a = await toAttachment(file, String(++attachSeq));
      } catch {
        setAttachErr(t("composer.attach.unreadable", { name: file.name || "file" }));
        continue;
      }
      if (full()) return;
      setAttachments((list) => [...list, a]);
    }
  };
  const canAttach = () => caps()?.attachments === true;

  const deliver = async (out: Outgoing) => {
    setSendErr("");
    // A confirmation about the run that just ended says nothing about the one
    // starting, and two of them stacked read as a session stopped twice.
    setStopped(false);
    setPendingSend(true);
    setHistIndex(-1);
    // The reader's own sentence goes on screen now. Until the store's turn
    // count passes this baseline, `turns()` draws it in place of a turn the
    // backend has not produced yet; a send that fails clears it below, and a
    // send that succeeds clears it by itself.
    setEcho({ base: settled(view)?.turns.length ?? 0, text: out.text });
    if (out.text) writeHistory(rememberPrompt(readHistory(), out.text));
    const chosen = selectedModel();
    const implied = !chosen && variantSel() ? effortModel() : undefined;
    const source = chosen ?? implied;
    const model = source
      ? { providerID: source.providerID, modelID: source.modelID }
      : splitModel(modelSel());
    const choice = { model, agent: agentSel() || undefined, variant: variantSel() || undefined };
    const command = caps()?.commands ? commandOf(out.text, (commands() ?? []).map((c) => c.name)) : undefined;
    try {
      if (out.revertTurnId) {
        try {
          await revertSession(props.id, out.revertTurnId);
        } catch (err) {
          // A later edit owns the signal now; don't overwrite it with this failure.
          if (editTurnId() === undefined) setEditTurnId(out.revertTurnId);
          throw err;
        }
      }
      if (command) {
        await runCommand(props.id, { ...command, parts: commandParts(out.text, out.picked, out.attachments) }, choice);
      } else {
        await sendPrompt(props.id, promptParts(out.text, out.picked, out.attachments), choice);
      }
    } catch (err) {
      setSendErr(explainSend(err instanceof Error ? err.message : "", t("err.send")));
      const back = restoreFailed(out, { text: draft(), picked: picked(), attachments: attachments() });
      setDraft(back.draft.text);
      setPicked(back.draft.picked);
      setAttachments(back.draft.attachments);
      if (back.dropped) setAttachErr(t("composer.attach.too_many", { n: MAX_ATTACHMENTS }));
      setQueuePaused(true);
      setPendingSend(false);
      setEcho(undefined);
      queueMicrotask(autogrow);
    }
  };

  const send = () => {
    const revertTurnId = editTurnId();
    if (revertTurnId) setEditTurnId(undefined);
    const out: Outgoing = {
      text: draft().trim(),
      picked: picked(),
      attachments: attachments(),
      ...(revertTurnId ? { revertTurnId } : {}),
    };
    if (!out.text && out.attachments.length === 0) return;
    setQueuePaused(false);
    setDraft("");
    setPicked([]);
    setAttachments([]);
    setAttachErr("");
    setTrigger(undefined);
    if (draftEl) draftEl.style.height = "auto";
    if (generating()) {
      setQueued((q) => [...q, out]);
      setHistIndex(-1);
      return;
    }
    void deliver(out);
  };
  const canSend = () => Boolean(draft().trim()) || attachments().length > 0;

  // A follow-up typed while the agent is running waits here, then goes out
  // on the next idle. deliver() sets pendingSend in the same turn, so this
  // does not drain the rest of the queue until that turn finishes.
  createEffect(() => {
    if (generating() || replayPos() !== null || queuePaused()) return;
    const next = queued()[0];
    if (!next) return;
    setQueued((q) => q.slice(1));
    void deliver(next);
  });

  const editQueued = (index: number) => {
    const item = queued()[index];
    if (!item) return;
    const current: Outgoing = { text: draft().trim(), picked: picked(), attachments: attachments() };
    setQueued((q) => {
      const rest = q.filter((_, i) => i !== index);
      return current.text || current.attachments.length ? [...rest, current] : rest;
    });
    setHistIndex(-1);
    setDraft(item.text);
    setPicked(item.picked);
    setAttachments(item.attachments);
    setTrigger(undefined);
    queueMicrotask(() => {
      autogrow();
      draftEl?.focus();
    });
  };

  const context = () => {
    const id = modelSel();
    const model = (settled(options)?.models ?? []).find((m) => `${m.providerID}/${m.modelID}` === id);
    return sessionContext(settled(view)?.turns ?? [], model?.context);
  };
  const contextLabel = (total: number, percent: number | null) =>
    percent == null
      ? t("context.none", { n: num(total) })
      : t("context.percent", { percent, n: num(total) });

  /**
   * The composer toolbar's pickers and details popover. They are functions
   * because the toolbar instantiates agent and effort twice — once inline and
   * once inside the compact popover — and one element cannot be both.
   */
  const contextSlot = () => (
    <Popover gutter={8} placement="top-start">
      <Tip label={contextLabel(context()?.total ?? 0, context()?.percent ?? null)}>
        <PopoverTrigger
          class="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-secondary"
          aria-label={t("composer.details")}
        >
          <ContextRing percent={context()?.percent ?? null} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent>
        <Show when={settled(view)}>
          {(v) => (
            <SessionInfo
              id={props.id}
              totals={v().totals}
              context={context()}
              model={modelSel()}
              backend={v().backend}
              status={v().status}
              workspace={v().workspace}
            />
          )}
        </Show>
      </PopoverContent>
    </Popover>
  );
  const modelAvailable = () =>
    (settled(options)?.models.length ?? 0) > 0 && (Boolean(modelSel()) || !booting());
  const modelSlot = () => (
    <Picker
      showValueInTip
      label={t("picker.model")}
      value={modelSel()}
      options={modelOptions()}
      class="composer-model max-w-40"
      onChange={(value) => {
        setModelTouched(true);
        setModelSel(value);
        setVariantSel("");
      }}
    />
  );
  const effortSlot = () => (
    <Picker
      showValueInTip
      label={t("picker.effort")}
      capitalize
      emptyOption={t("picker.default")}
      placeholder={t("picker.default")}
      value={variantSel()}
      options={(effortModel()?.variants ?? []).map((name) => ({ value: name, label: name }))}
      onChange={setVariantSel}
      class="max-w-24"
    />
  );
  const agentSlot = () => (
    <Picker
      showValueInTip
      label={opencode() ? t("picker.agent.tip") : t("picker.agent")}
      capitalize
      value={agentSel()}
      options={(settled(options)?.agents ?? []).map((a) => ({ value: a.name, label: a.name }))}
      onChange={setAgentSel}
      class="max-w-24"
    />
  );

  /**
   * A stop the reader asked for and the backend has not confirmed yet.
   *
   * The abort POST returning is not evidence that anything stopped: it returns
   * when the request is accepted, and the agent is still generating. Measured on
   * a live session, the old code held "停止中" for about 200ms — shorter than
   * the blink it takes to notice — and then flipped the button back with the
   * transcript showing nothing at all, so a stop that worked, a stop that
   * missed, and a stop aimed at the wrong session were the same picture.
   *
   * The event log has no `session.ended` for an abort either — a stopped
   * session holds `session.status busy` then `idle` and nothing else — so the
   * session being idle is the whole of the confirmation. This watches that
   * condition rather than the transition into it: the session can go idle
   * between the reader deciding to stop and the request landing, and a listener
   * on the event would then wait for an event that has already been and gone,
   * and report a stop that worked as one that failed.
   */
  const [stopping, setStopping] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  /**
   * Whether the backend has taken the abort.
   *
   * The view behind this is not a witness. It is a re-fetch, and on a long
   * session that is the slowest thing on screen: `busy` stays whatever it last
   * was until the fetch lands, so waiting for it to say idle means waiting on
   * the slowest part of a system that has already answered. Measured on a
   * 2,272-event session, the abort itself came back in 420ms — and the watchdog
   * would have gone on asking for eight.
   *
   * The abort POST returning 200 is the answer: the service returns it only
   * after the backend has taken the request, and a 502 that says otherwise
   * arrives here as a thrown error instead.
   */
  const [abortAccepted, setAbortAccepted] = createSignal(false);

  createEffect(() => {
    if (!stopping()) return;
    if (stopConfirmed(abortAccepted(), generating())) {
      setStopping(false);
      setStopped(true);
    }
  });

  const STOP_TIMEOUT = 8_000;
  createEffect(() => {
    if (!stopping()) return;
    const id = setTimeout(() => {
      // Still running after all that. Say which of the two it is, rather than
      // leaving a button that looks exactly like the one that was never pressed.
      if (!stopping()) return;
      setStopping(false);
      setStopped(false);
      setSendErr(t("stop.unconfirmed"));
    }, STOP_TIMEOUT);
    onCleanup(() => clearTimeout(id));
  });

  const stop = async () => {
    if (stopping()) return;
    setSendErr("");
    setStopped(false);
    setStopping(true);
    setAbortAccepted(false);
    // Before the request, not after it. `pendingSend` says "the reader handed a
    // prompt over and nothing has come back yet", and pressing stop makes that
    // untrue the moment the reader presses it — the prompt is no longer waiting
    // on anything. It used to be cleared after `await abortSession`, which put a
    // network round trip between pressing the button and the session reading as
    // not generating; on a long session, where the view behind it is a full
    // re-fetch, that round trip is long enough for the watchdog to fire first and
    // report a stop that worked as one that did not.
    setPendingSend(false);
    try {
      await abortSession(props.id);
      // The backend returns once it has taken the abort, which is the strongest
      // confirmation available: a 502 means it did not, and says so. Re-reading
      // the view is the cross-check, not the primary evidence.
      setAbortAccepted(true);
      void refreshView(false);
    } catch (err) {
      setStopping(false);
      setSendErr(explainSend(err instanceof Error ? err.message : "", t("err.abort")));
    }
  };

  /**
   * One panel on the right, opened only by the reader. Trace and replay step
   * out of the way while it is open, and the choice persists across sessions.
   */
  const openPanel = (tab?: SidePanelTab) => {
    setTraceBlock(null);
    setReplayPos(null);
    if (tab) {
      setPanelTab(tab);
      writePanelTab(tab);
    }
    setPanelOpen(true);
    writePanelOpen(true);
  };
  const closePanel = () => {
    setPanelOpen(false);
    writePanelOpen(false);
  };
  const togglePanel = () => {
    // The trace drawer borrows the same edge while the panel stays open, so the
    // reader's next click still means "show me the panel", not "close nothing".
    if (panelOpen() && !traceBlock()) closePanel();
    else openPanel();
  };
  const selectTab = (tab: SidePanelTab) => {
    setPanelTab(tab);
    writePanelTab(tab);
  };
  // The file browser only exists for the OpenCode backend.
  const effectiveTab = (): SidePanelTab => (opencode() ? panelTab() : "changes");

  const childOf = (id: string) => {
    const row = props.sessions.find((s) => s.summary.session_id === id);
    if (!row) return undefined;
    return { title: row.title ?? "", status: row.status, busy: row.busy };
  };
  const openChild = (id: string) => {
    location.hash = `/session/${encodeURIComponent(id)}`;
  };

  const editTurn = (turnId: string, text: string) => {
    setDraft(text);
    setPicked([]);
    setAttachments([]);
    setAttachErr("");
    setEditTurnId(turnId);
    queueMicrotask(() => {
      autogrow();
      draftEl?.focus();
    });
  };

  const revertTurn = (turnId: string) => {
    void revertSession(props.id, turnId).catch((err) =>
      setSendErr(err instanceof Error ? err.message : t("err.network")),
    );
  };

  const forkTurn = (turnId: string) => {
    void forkSession(props.id, turnId)
      .then((id) => {
        location.hash = `/session/${encodeURIComponent(id)}`;
      })
      .catch((err) => setSendErr(err instanceof Error ? err.message : t("err.network")));
  };

  // Ctrl+F stays "find in what I am reading". Windowing the transcript took the
  // browser's own find away, so the shortcut goes to the session index.
  onCleanup(
    registerCommand({
      id: "session.find",
      title: () => t("session.search.label"),
      chord: { key: "f" },
      run: () => {
        if (searchOpen()) searchEl?.focus();
        else openSearch();
      },
    }),
  );
  onCleanup(
    registerCommand({
      id: "session.terminal",
      title: () => (terminalOn() ? t("terminal.hide") : t("terminal.show")),
      chord: { key: "`" },
      enabled: () => opencode(),
      run: () => setTerminalOn((on) => !on),
    }),
  );
  onCleanup(
    registerCommand({
      id: "session.panel",
      title: () => (panelOpen() ? t("panel.hide") : t("panel.show")),
      run: () => togglePanel(),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.splitRight",
      title: () => t("pane.split.right"),
      run: () => handleSplitPane(paneWorkspace().focusedPaneId, "row"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.splitDown",
      title: () => t("pane.split.down"),
      run: () => handleSplitPane(paneWorkspace().focusedPaneId, "col"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.grid4",
      title: () => t("pane.mode.grid4"),
      run: () => handleSelectPreset("grid-4"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.single",
      title: () => t("pane.mode.single"),
      run: () => handleSelectPreset("single"),
    }),
  );

  return (
    <div class="flex h-full min-h-0">
      <div class="@container/session relative flex min-w-0 flex-1 flex-col">
        <Show
          when={settled(view)}
          fallback={
            <div class="flex h-full min-h-0 flex-col">
              <DragBar />
              <Show
                when={view.error}
                fallback={<LoadingTranscript />}
              >
                <div class="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon="alert"
                    tone="danger"
                    title={t("session.service_unreachable")}
                    description={t("session.service_unreachable_hint")}
                    action={
                      <Button
                        size="sm"
                        onClick={() => {
                          retries = 0;
                          void refetch();
                        }}
                      >
                        {t("session.retry")}
                      </Button>
                    }
                  />
                </div>
              </Show>
            </div>
          }
        >
          {(v) => (
            <>
              <header
                class="@container flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <div class="flex min-w-0 flex-1 items-baseline gap-2">
                  <Show when={v().parent_session_id}>
                    {(parentId) => {
                      const parent = () => props.sessions.find((s) => s.summary.session_id === parentId());
                      return (
                        <Button
                          type="button"
                          variant="quiet"
                          size="sm"
                          class="h-auto max-w-48 shrink-0 truncate px-0 py-0 text-sm"
                          onClick={() => {
                            location.hash = `/session/${encodeURIComponent(parentId())}`;
                          }}
                        >
                          {parent()?.title || t("session.child.back")}
                        </Button>
                      );
                    }}
                  </Show>
                  {/* Identity first. `flex-1` on a zero basis takes the free space, and the
                      min-width floor means the title gives up its width last.
                      The chips beside it stop being offered any width at all
                      below 440px — a truncated chip renders one glyph and then
                      reads as corruption, and both are on screen elsewhere (the
                      branch in the footer, the workspace in the sidebar). Before
                      this the title reached 0px at the window's 960px minimum
                      and the session you were reading had no name on screen. */}
                  <h1
                    class="min-w-24 flex-1 truncate text-sm font-medium"
                    title={v().title ?? t("session.untitled")}
                  >
                    {v().title ?? t("session.untitled")}
                  </h1>
                  <Show when={realWorkspace(v().workspace)}>
                    {(ws) => (
                      <span
                        class="max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground @max-[440px]:hidden"
                        title={ws()}
                      >
                        {ws() === "/" || ws() === "\\" ? t("path.root") : ws().split(/[/\\]/).filter(Boolean).at(-1)}
                      </span>
                    )}
                  </Show>
                  <Show when={settled(vcs)?.branch}>
                    {(branch) => (
                      <Tip
                        label={t("header.branch.tip", { branch: branch() })}
                        class="@max-[440px]:hidden"
                      >
                        <span class="flex max-w-32 shrink-0 items-baseline gap-1 font-mono text-2xs text-muted-foreground">
                          <Icon name="branch" class="h-3 w-3 shrink-0 self-center" />
                          <span class="truncate">{branch()}</span>
                        </span>
                      </Tip>
                    )}
                  </Show>
                </div>
                <span class="flex shrink-0 items-center gap-0.5">
                  <Show when={v().totals.cost_usd > 0}>
                    <Tip label={t("header.cost.tip", { amount: fmtUsd(v().totals.cost_usd) })}>
                      <span class="mr-1 font-mono text-2xs text-muted-foreground tabular-nums">
                        {fmtUsd(v().totals.cost_usd)}
                      </span>
                    </Tip>
                  </Show>
                  <Tip label={t("session.search.tip", { shortcut: findKey() })}>
                  <PanelToggle
                    label={t("session.search.label")}
                    on={searchOpen()}
                    expanded={searchOpen()}
                    onClick={() => (searchOpen() ? closeSearch() : openSearch())}
                  >
                    <Icon name="search" />
                  </PanelToggle>
                </Tip>
                <Show when={opencode()}>
                    <Tip label={terminalOn() ? t("terminal.hide") : t("terminal.show")}>
                      <PanelToggle
                        label={terminalOn() ? t("terminal.hide") : t("terminal.show")}
                        on={terminalOn()}
                        pressed={terminalOn()}
                        onClick={() => setTerminalOn((on) => !on)}
                      >
                        <Icon name="terminal" />
                      </PanelToggle>
                    </Tip>
                  </Show>
                  <Tip label={panelOpen() ? t("panel.hide") : t("panel.show")}>
                    <PanelToggle
                      label={panelOpen() ? t("panel.hide") : t("panel.show")}
                      on={panelOpen()}
                      pressed={panelOpen()}
                      onClick={togglePanel}
                    >
                      <Icon name="files" />
                    </PanelToggle>
                  </Tip>
                  <Tip label={traceOn() ? t("trace.live") : t("trace.replay")}>
                    <PanelToggle
                      label={traceOn() ? t("trace.live") : t("trace.replay")}
                      on={traceOn()}
                      pressed={traceOn()}
                      onClick={() => {
                        if (traceOn()) {
                          setTraceOn(false);
                          setTraceBlock(null);
                          setReplayPos(null);
                        } else {
                          setTraceOn(true);
                        }
                      }}
                    >
                      <Icon name="replay" />
                    </PanelToggle>
                  </Tip>
                  <Show when={opencode()}>
                    <Tip label={t("header.tools")}>
                      <PanelToggle
                        label={t("header.tools")}
                        on={toolsOpen()}
                        pressed={toolsOpen()}
                        onClick={toggleTools}
                      >
                        <Icon name="plug" />
                      </PanelToggle>
                    </Tip>
                  </Show>
                  <LayoutSwitcher
                    workspace={paneWorkspace()}
                    onPreset={handleSelectPreset}
                    onSplit={(dir) => handleSplitPane(paneWorkspace().focusedPaneId, dir)}
                    onToggleZoom={() => handleToggleZoom(paneWorkspace().focusedPaneId)}
                  />
                  <Tip label={t("header.export")}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="icon"
                      aria-label={t("header.export")}
                      onClick={() =>
                        void downloadExport(v().session_id).catch((err) =>
                          setSendErr(err instanceof Error ? err.message : t("err.network")),
                        )
                      }
                    >
                      <Icon name="download" />
                    </Button>
                  </Tip>
                </span>
              </header>

              <Show when={searchOpen()}>
                <div class="absolute right-4 top-11 z-30 w-[26rem] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Icon name="search" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <TextFieldInput
                      ref={(el) => (searchEl = el)}
                      bare
                      class="min-w-0 flex-1"
                      placeholder={t("session.search.placeholder")}
                      value={query()}
                      onInput={(e) => onQuery(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          step(e.shiftKey ? -1 : 1);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          closeSearch();
                        }
                      }}
                    />
                    <Show when={probe()}>
                      <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {result.loading
                          ? "…"
                          : targets().length
                            ? `${hitAt() + 1}/${targets().length}${result()?.more ? "+" : ""}`
                            : t("session.search.counter.none")}
                      </span>
                    </Show>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="icon"
                      aria-label={t("session.search.prev")}
                      disabled={!targets().length}
                      onClick={() => step(-1)}
                    >
                      <Icon name="chevron" class="h-3.5 w-3.5 rotate-180" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="icon"
                      aria-label={t("session.search.next")}
                      disabled={!targets().length}
                      onClick={() => step(1)}
                    >
                      <Icon name="chevron" class="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <Show
                    when={targets().length > 0}
                    fallback={
                      <Show when={probe() && !result.loading}>
                        <p class="px-3 py-4 text-center text-xs text-muted-foreground">
                          {t("session.search.empty")}
                        </p>
                      </Show>
                    }
                  >
                    <ul ref={(el) => (resultsEl = el)} class="max-h-72 overflow-x-hidden overflow-y-auto py-1">
                      <For each={targets()}>
                        {(h, i) => (
                          <li>
                            <RowButton
                              data-hit={i()}
                              // `items-stretch` is not decoration: the base row is a
                              // horizontal flex box, and a column box would centre its
                              // snippet horizontally without it.
                              class={`flex-col items-stretch gap-0.5 px-3 ${
                                i() === hitAt() ? "bg-secondary" : ""
                              }`}
                              active={i() === hitAt()}
                              onClick={() => {
                                setHitAt(i());
                                goTo(h);
                              }}
                            >
                              <Snippet text={h.snippet} />
                              <span class="font-mono text-2xs text-muted-foreground">
                                {t("session.search.turn", { n: turnNumber(h) })}
                              </span>
                            </RowButton>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </Show>

              <Show when={toolsOpen()}>
                <div class="absolute right-4 top-11 z-30 w-80 max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <div class="max-h-80 overflow-y-auto px-2 py-2">
                    <h2 class="px-1.5 text-2xs font-medium text-muted-foreground">{t("mcp.title")}</h2>
                    <Show when={toolsReady() && mcpServers().length === 0}>
                      <p class="mt-1.5 px-1.5 text-xs text-muted-foreground">{t("mcp.empty")}</p>
                    </Show>
                    <Show when={mcpServers().length > 0}>
                      <ul class="mt-1">
                        <For each={mcpServers()}>
                          {([name, server]) => {
                            const busy = () => mcpBusy() === name;
                            const note = () => (mcpNote()?.name === name ? mcpNote()?.text : undefined);
                            const canDisconnect = () => server.status === "connected";
                            const canConnect = () => server.status === "disabled" || server.status === "failed";
                            const canAuth = () => server.status === "needs_auth" && mcpAuth()?.name !== name;
                            return (
                              <li class="rounded-md px-1.5 py-1.5">
                                <div class="flex items-center gap-2">
                                <span
                                  class={`size-1.5 shrink-0 rounded-full ${mcpDot(server.status)} ${busy() ? "animate-pulse" : ""}`}
                                />
                                <div class="min-w-0 flex-1">
                                  <div class="truncate text-sm">{name}</div>
                                  <div
                                    class={`truncate text-2xs ${
                                      server.status === "connected"
                                        ? "text-status-active"
                                        : server.status === "failed"
                                          ? "text-status-error"
                                          : "text-muted-foreground"
                                    }`}
                                  >
                                    {busy()
                                      ? t(
                                          canDisconnect()
                                            ? "mcp.disconnecting"
                                            : canAuth()
                                              ? "mcp.auth"
                                              : "mcp.connecting",
                                        )
                                      : t(MCP_STATUS[server.status])}
                                    <Show
                                      when={
                                        !busy() &&
                                        (server.status === "failed" ||
                                          server.status === "needs_client_registration") &&
                                        server.error
                                      }
                                    >
                                      {` · ${server.error}`}
                                    </Show>
                                  </div>
                                  <Show when={note()}>
                                    <div class="truncate text-2xs text-muted-foreground">{note()}</div>
                                  </Show>
                                </div>
                                <Show when={canDisconnect() || canConnect() || canAuth()}>
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="icon"
                                    disabled={busy()}
                                    onClick={() => {
                                      if (canAuth()) void beginMcpAuth(name);
                                      else void toggleMcp(name, canDisconnect() ? "disconnect" : "connect");
                                    }}
                                  >
                                    {busy()
                                      ? t(canDisconnect() ? "mcp.disconnecting" : canAuth() ? "mcp.auth" : "mcp.connecting")
                                      : t(canDisconnect() ? "mcp.disconnect" : canAuth() ? "mcp.auth" : "mcp.connect")}
                                  </Button>
                                </Show>
                                </div>
                                <Show when={mcpAuth()?.name === name ? mcpAuth() : undefined}>
                                  {(auth) => (
                                    <div class="mt-1.5 pl-3.5">
                                      <a
                                        class="text-xs text-foreground underline"
                                        href={auth().url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {t("mcp.auth.open")}
                                      </a>
                                      <p class="mt-1 text-2xs text-muted-foreground">{t("mcp.auth.hint")}</p>
                                      <form
                                        class="mt-1.5 flex gap-1"
                                        onSubmit={(e) => {
                                          e.preventDefault();
                                          void finishMcpAuth(name);
                                        }}
                                      >
                                        <TextFieldInput
                                          size="xs"
                                          class="min-w-0 flex-1"
                                          aria-label={t("mcp.auth.code")}
                                          placeholder={t("mcp.auth.code")}
                                          autocomplete="off"
                                          spellcheck={false}
                                          value={mcpCode()}
                                          onInput={(e) => setMcpCode(e.currentTarget.value)}
                                        />
                                        <Button
                                          type="submit"
                                          size="xs"
                                          variant="outline"
                                          class="h-7 shrink-0"
                                          disabled={busy() || !mcpCode().trim()}
                                        >
                                          {t("mcp.auth.confirm")}
                                        </Button>
                                      </form>
                                      <Button
                                        type="button"
                                        size="xs"
                                        variant="icon"
                                        class="mt-1.5"
                                        onClick={cancelMcpAuth}
                                      >
                                        {t("mcp.auth.cancel")}
                                      </Button>
                                    </div>
                                  )}
                                </Show>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </Show>
                    <Show when={toolsReady()}>
                      <form class="mt-2 border-t border-border px-1.5 pt-2" onSubmit={(e) => void submitMcp(e)}>
                        <div class="text-2xs font-medium text-muted-foreground">{t("mcp.add")}</div>
                        <TextFieldInput
                          size="xs"
                          value={mcpName()}
                          placeholder={t("mcp.add.name")}
                          class="mt-1.5"
                          onInput={(e) => setMcpName(e.currentTarget.value)}
                        />
                        <MiniTabs
                          kind="radio"
                          label={t("mcp.add")}
                          value={mcpKind()}
                          onChange={(id) => setMcpKind(id as "url" | "command")}
                          options={[
                            { id: "url", label: t("mcp.add.url") },
                            { id: "command", label: t("mcp.add.command") },
                          ]}
                          class="mt-1.5 gap-1"
                        />
                        <TextFieldInput
                          size="xs"
                          mono
                          value={mcpValue()}
                          placeholder={t(mcpKind() === "command" ? "mcp.add.command.placeholder" : "mcp.add.url.placeholder")}
                          class="mt-1.5"
                          onInput={(e) => setMcpValue(e.currentTarget.value)}
                        />
                        <p class="mt-1.5 text-2xs text-muted-foreground">{t("mcp.add.hint")}</p>
                        <Show when={mcpAddErr()}>
                          <p class="mt-1 text-2xs text-status-error">{mcpAddErr()}</p>
                        </Show>
                        <Button
                          type="submit"
                          size="xs"
                          variant="outline"
                          class="mt-1.5"
                          disabled={mcpAdding() || !mcpName().trim() || !mcpValue().trim()}
                        >
                          {t(mcpAdding() ? "mcp.add.adding" : "mcp.add.submit")}
                        </Button>
                      </form>
                    </Show>
                  </div>
                </div>
              </Show>

              <Show when={traceOn()}>
                <TraceStrip
                  sessionId={props.id}
                  selected={traceBlock()?.key ?? null}
                  onSelect={(block) => {
                    if (traceBlock()?.key === block.key) {
                      setTraceBlock(null);
                      setReplayPos(null);
                      return;
                    }
                    setTraceBlock(block);
                    setReplayPos(block.seq);
                  }}
                />
              </Show>

              {/* `min-h-0` alone lets the dock take everything. The transcript
                  is the thing the reader came for, so it gets a floor: a dock
                  that grows past this much pushes the dock's own scrollbox
                  rather than collapsing the conversation to a strip. It is also
                  what stops the entry jump — the column arrives at full height
                  and is then squeezed when the pending questions land, and the
                  reader sees their transcript compress rather than the dock
                  expand into room that was already there. */}
              <PaneStage
                workspace={paneWorkspace()}
                sessions={props.sessions}
                onFocusPane={handleFocusPane}
                onSelectPaneSession={handleSelectPaneSession}
                onSplitPane={handleSplitPane}
                onClosePane={handleClosePane}
                onToggleZoom={handleToggleZoom}
                onResizeSplit={handleResizeSplit}
                renderPeerTranscript={(peerSessionId, paneId) => (
                  <PeerSessionTranscript
                    sessionId={peerSessionId}
                    paneId={paneId}
                    sessions={props.sessions}
                    onFocus={() => handleFocusPane(paneId, peerSessionId)}
                    onOpenChild={openChild}
                  />
                )}
                renderFocusedTranscript={() => (
              <div class={`relative flex flex-1 flex-col ${paneWorkspace().mode === "multiplex" ? "min-h-0" : "min-h-[30vh]"}`}>
              <div
                ref={(el) => {
                  scroller = el;
                  const memKey = `${paneWorkspace().focusedPaneId}:${props.id}`;
                  queueMicrotask(() => {
                    if (!el) return;
                    setViewport(el.clientHeight);
                    const remembered = paneScrollMemory.get(memKey);
                    if (remembered && !remembered.pinned && remembered.scrollTop > 0) {
                      el.scrollTop = remembered.scrollTop;
                      setScrollTop(remembered.scrollTop);
                      setPinned(false);
                    }
                  });
                }}
                // overflow-x is stated, not left out. CSS turns a `visible`
                // overflow-x into `auto` whenever overflow-y is a scroller, so
                // any one row wider than the column grew a horizontal scrollbar
                // that shrank the column — and windowing meant that row came and
                // went while scrolling, so the whole transcript breathed in and
                // out. Everything inside already scrolls or wraps on its own.
                class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
                  setScrollTop(el.scrollTop);
                  setViewport(el.clientHeight);
                  setPinned(isPinned);
                  setActiveTurn(list?.indexAtTop() ?? 0);
                  paneScrollMemory.set(`${paneWorkspace().focusedPaneId}:${props.id}`, {
                    scrollTop: el.scrollTop,
                    pinned: isPinned,
                  });
                }}
              >
                <div
                  class={
                    showNav()
                      ? "mx-auto w-full max-w-3xl py-4 pl-11 pr-5"
                      : "mx-auto w-full max-w-3xl px-5 py-4"
                  }
                >
                  <Show
                    when={!booting() && !(importing() && turns().length === 0)}
                    fallback={<LoadingTranscript />}
                  >
                    <Show
                      when={turns().length > 0}
                      fallback={
                        <Show
                          when={!lastSilentTurn()}
                          fallback={
                            <div class="flex justify-center">
                              <EmptyState
                                icon="brain"
                                title={t("transcript.thinking")}
                                class="py-10"
                              />
                            </div>
                          }
                        >
                          <div class="flex justify-center">
                            <EmptyState
                              icon="spark"
                              title={t("session.empty")}
                              description={t("session.empty_hint")}
                              class="py-10"
                            />
                          </div>
                        </Show>
                      }
                    >
                    <Virtual
                      items={turns()}
                      id={(t) => t.turn_id}
                      estimate={100}
                      gap={32}
                      scrollTop={scrollTop()}
                      viewport={viewport()}
                      scroller={() => scroller}
                      api={(a) => {
                        list = a;
                        setActiveTurn(a.indexAtTop());
                      }}
                    >
                      {(turn) => (
                        <div data-turn-id={turn().turn_id}>
                          <TurnBlock
                            turn={turn()}
                            awaiting={() =>
                              turn().turn_id === ECHO_TURN_ID || lastSilentTurn() === turn()
                            }
                            childOf={childOf}
                            onOpenChild={openChild}
                            onEdit={editTurn}
                            onRevert={caps()?.revert ? revertTurn : undefined}
                            onFork={caps()?.fork ? forkTurn : undefined}
                          />
                        </div>
                      )}
                    </Virtual>
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={showNav()}>
                <PromptNavigator
                  entries={entries()}
                  activeId={activeEntry()?.turnId}
                  onSelect={jumpToTurn}
                />
              </Show>
              <Show when={!booting() && replayPos() === null && !pinned() && v().turns.length > 0}>
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  class="surface-popover absolute bottom-4 left-1/2 z-20 h-auto -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 shadow-md"
                  onClick={jumpToLatest}
                >
                  {t("nav.latest")}
                </Button>
              </Show>
              </div>
                )}
              />

              <Show when={replayPos() === null}>
                {/*
                  The dock is `shrink-0`, so whatever it takes, the transcript
                  does not get. That made the cap on the card stack a fiction:
                  `max-h-[45vh]` bounded the cards, but the dock's own `pt-6 pb-4`
                  and the composer below it were outside it, and the measured
                  total was 548px against a 900px window — 405 of cards plus 40 of
                  padding plus a 103px composer. The transcript was left 232px,
                  and since it arrives at full height and is then squeezed, the
                  reader watches their conversation compress on entry.

                  The cap therefore belongs to the dock, not to the cards inside
                  it, and it has to leave the composer room: the composer is
                  where a pending question is answered, so a cap that buried it
                  would answer the reader's problem by taking away the only way
                  out of it. `max-h-[55vh]` on the scrollable region keeps both,
                  and the composer stays outside it, pinned where it is.
                */}
                <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-4 pt-6">
                  <div class="mx-auto w-full max-w-3xl space-y-2">
                    {/* Pending asks and questions share the dock with the
                        composer, and the dock is `shrink-0` — four stacked
                        prompts measured 1024px against a 900px window, which
                        took every pixel the transcript had and left that column
                        at zero height, so the "back to latest" control, anchored
                        to it, landed in the title bar. The stack now takes at
                        most half the window and scrolls; the composer stays
                        where it is. */}
                    <div class="max-h-[40vh] overflow-y-auto">
                      <div class="space-y-2">
                    {/* A prompt that fails to load is the worst thing that can
                        happen here: the agent is waiting for an answer the user
                        cannot see, and the session looks stuck rather than
                        broken. Say so, and let them ask again. */}
                    <Show when={questions.error || asks.error}>
                      <div class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                        <Icon name="alert" class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-destructive">
                            {t("prompt.load_failed")}
                          </div>
                          <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">
                            {t("prompt.load_failed_hint")}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          class="shrink-0"
                          onClick={() => {
                            void refetchQuestions();
                            void refetchAsks();
                          }}
                        >
                          {t("session.retry")}
                        </Button>
                      </div>
                    </Show>
                    <For each={openAsks()}>
                      {(p) => (
                        <AskCard
                          ask={p}
                          onRespond={(id, decision, scope) => void respond(id, decision, scope)}
                        />
                      )}
                    </For>
                    <For each={settled(questions) ?? []}>
                      {(q) => (
                        <QuestionCard
                          q={q}
                          onDone={() => {
                            refetchQuestions();
                            void refreshView();
                          }}
                        />
                      )}
                    </For>
                      </div>
                    </div>
                    <Show when={v().revert_turn_id}>
                      <div class="flex items-center justify-between gap-2 px-1">
                        <span class="text-2xs text-muted-foreground">{t("message.reverted")}</span>
                        <Button
                          type="button"
                          variant="quiet"
                          size="xs"
                          class="h-auto px-0 py-0"
                          onClick={() =>
                            void unrevertSession(props.id).catch((err) =>
                              setSendErr(err instanceof Error ? err.message : t("err.network")),
                            )
                          }
                        >
                          {t("message.restore")}
                        </Button>
                      </div>
                    </Show>
                    <div class="relative">
                      <Show when={menuOpen()}>
                        <ComposerMenu
                          id={menuId}
                          kind={trigger()?.kind ?? "file"}
                          items={menuItems()}
                          active={menuActive()}
                          hint={menuHint()}
                          onPick={pick}
                          onHover={setMenuActive}
                        />
                      </Show>
                      <Show when={planVisible(v().plan, generating())}>
                        <PlanStrip sessionId={props.id} plan={v().plan!} generating={generating()} />
                      </Show>
                      <Show when={queued().length > 0}>
                        <div
                          class={`border border-b-0 bg-secondary/70 px-3 pb-4 pt-2 ${
                            planVisible(v().plan, generating())
                              ? "border-input border-t-input/60"
                              : "rounded-t-2xl border-input"
                          }`}
                        >
                          <p class="text-2xs font-medium text-muted-foreground">
                            {tn("composer.queued", queued().length)}
                          </p>
                          <ul class="mt-1 space-y-1">
                            <For each={queued()}>
                              {(item, i) => (
                                <li class="flex items-center gap-2">
                                  <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                                    <span class="min-w-0 truncate text-sm">{item.text}</span>
                                    <Show when={item.attachments.length}>
                                      <span class="shrink-0 text-2xs text-muted-foreground">
                                        {tn("composer.attachments", item.attachments.length)}
                                      </span>
                                    </Show>
                                  </span>
                                  <Button
                                    type="button"
                                    variant="quiet"
                                    size="xs"
                                    class="h-auto shrink-0 px-0 py-0 text-xs"
                                    onClick={() => editQueued(i())}
                                  >
                                    {t("composer.edit")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="icon-2xs"
                                    variant="icon"
                                    class="hover:bg-background"
                                    aria-label={t("composer.remove_queued")}
                                    onClick={() => setQueued((q) => q.filter((_, n) => n !== i()))}
                                  >
                                    ×
                                  </Button>
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>
                    <div
                      class={`@container/composer rounded-2xl border border-input bg-card shadow-[0_8px_30px_-18px_rgba(0,0,0,0.7)] transition-colors focus-within:border-ring ${queued().length > 0 || planVisible(v().plan, generating()) ? "-mt-2" : ""}`}
                      onDragOver={(e) => {
                        if (!canAttach() || !e.dataTransfer?.types.includes("Files")) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "copy";
                      }}
                      onDrop={(e) => {
                        if (!canAttach() || !e.dataTransfer?.files.length) return;
                        e.preventDefault();
                        void addFiles(e.dataTransfer.files);
                      }}
                    >
                      <Show when={attachments().length}>
                        <AttachmentStrip
                          items={attachments()}
                          onRemove={(id) => {
                            setAttachErr("");
                            setAttachments((l) => l.filter((a) => a.id !== id));
                          }}
                        />
                      </Show>
                      <textarea
                        ref={draftEl}
                        class="max-h-56 w-full resize-none bg-transparent px-4 py-3 font-sans text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
                        rows={1}
                        placeholder={
                          paneWorkspace().mode === "multiplex"
                            ? generating()
                              ? t("pane.composer.queue_target", { title: v().title ?? t("session.untitled") })
                              : t("pane.composer.target", { title: v().title ?? t("session.untitled") })
                            : generating()
                              ? t("composer.placeholder.queue")
                              : t("composer.placeholder.message")
                        }
                        value={draft()}
                        aria-autocomplete="list"
                        aria-controls={menuOpen() && menuItems().length ? menuId : undefined}
                        aria-activedescendant={
                          menuOpen() && menuItems().length ? `${menuId}-${menuActive()}` : undefined
                        }
                        onInput={(e) => {
                          setDraft(e.currentTarget.value);
                          setHistIndex(-1);
                          autogrow();
                          if (!e.isComposing) track();
                        }}
                        onCompositionEnd={track}
                        onClick={track}
                        onBlur={() => setTrigger(undefined)}
                        onKeyUp={(e) => {
                          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") track();
                        }}
                        onPaste={(e) => {
                          // Office copies a selection as text plus a picture of it
                          if (canAttach() && e.clipboardData?.files.length && !e.clipboardData.getData("text/plain")) {
                            e.preventDefault();
                            void addFiles(e.clipboardData.files);
                          }
                        }}
                        onKeyDown={(e) => {
                          // 229: the key went to the IME, which some webviews report without isComposing
                          if (e.isComposing || e.keyCode === 229) return;
                          if (menuOpen()) {
                            const n = menuItems().length;
                            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                              e.preventDefault();
                              if (n) setMenuActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                              return;
                            }
                            if (e.key === "Enter" && !e.shiftKey && n) {
                              e.preventDefault();
                              const tr = trigger();
                              if (tr?.kind === "command" && menuItems()[menuActive()]?.value === tr.query) send();
                              else pick(menuActive());
                              return;
                            }
                            if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
                              e.preventDefault();
                              if (n && !e.shiftKey) pick(menuActive());
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              // App listens for Escape on window to close its own overlays
                              e.stopPropagation();
                              setDismissedAt(trigger()!.start);
                              return;
                            }
                          }
                          if (e.key === "Tab" && opencode() && !e.ctrlKey && !e.altKey && !e.metaKey) {
                            const names = (settled(options)?.agents ?? []).map((a) => a.name);
                            const next = stepAgent(names, agentSel(), e.shiftKey ? -1 : 1);
                            if (next) {
                              e.preventDefault();
                              setAgentSel(next);
                              return;
                            }
                          }
                          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.isComposing) {
                            const moved = navigateHistory({
                              direction: e.key === "ArrowUp" ? "up" : "down",
                              text: draft(),
                              cursor: e.currentTarget.selectionStart ?? 0,
                              index: histIndex(),
                              entries: readHistory(),
                              saved: histSaved(),
                            });
                            if (moved.handled) {
                              e.preventDefault();
                              if (histIndex() < 0) setHistSaved(draft());
                              setHistIndex(moved.index);
                              setDraft(moved.text);
                              setTrigger(undefined);
                              queueMicrotask(() => {
                                autogrow();
                                const pos = moved.cursor === "start" ? 0 : moved.text.length;
                                draftEl?.setSelectionRange(pos, pos);
                              });
                              return;
                            }
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                            e.preventDefault();
                            send();
                          }
                        }}
                      />
                      <Show when={canAttach()}>
                        <input
                          ref={fileInput}
                          type="file"
                          multiple
                          accept={ATTACHMENT_ACCEPT}
                          class="hidden"
                          onChange={(e) => {
                            const input = e.currentTarget;
                            if (input.files) void addFiles(input.files);
                            input.value = "";
                          }}
                        />
                      </Show>
                      <ComposerToolbar
                        context={contextSlot}
                        agent={(settled(options)?.agents.length ?? 0) > 0 ? agentSlot : undefined}
                        model={modelAvailable() ? modelSlot : undefined}
                        effort={(effortModel()?.variants?.length ?? 0) > 0 ? effortSlot : undefined}
                        onAttach={canAttach() ? () => fileInput?.click() : undefined}
                        generating={generating()}
                        stopping={stopping()}
                        canSend={canSend()}
                        onSend={send}
                        onStop={() => void stop()}
                      />
                    </div>
                    </div>
                    <Show when={sendErr()}>
                      <p class="font-mono text-2xs text-destructive">{sendErr()}</p>
                    </Show>
                    {/* The stop landed. Without this the button flips back to
                        Send and the transcript shows a turn that simply ends,
                        which is the same picture as a stop that did nothing. */}
                    <Show when={stopped()}>
                      <p class="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
                        <Icon name="stop" class="size-3 shrink-0" />
                        {t("stop.done")}
                      </p>
                    </Show>
                    <Show when={attachErr()}>
                      <p class="font-mono text-2xs text-destructive">{attachErr()}</p>
                    </Show>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={terminalOn() && opencode()}>
          <TerminalPane sessionId={props.id} />
        </Show>
        <Show when={opencode()}>
          <footer class="flex h-7 shrink-0 items-center gap-3 border-t border-border px-4 text-2xs text-muted-foreground">
            <span class="truncate">{settled(vcs)?.branch ? t("status.branch", { branch: settled(vcs)!.branch! }) : t("status.noBranch")}</span>
            <span class={lspServers()?.some((s) => s.status === "error") ? "text-destructive" : ""}>
              {lspServers()?.some((s) => s.status === "error")
                ? t("status.lspErr", { n: lspServers()!.filter((s) => s.status === "error").length })
                : t("status.lsp", { n: lspServers()?.length ?? 0 })}
            </span>
            <span>
              {t("status.mcp", {
                on: mcpServers().filter(([, s]) => s.status === "connected").length,
                n: mcpServers().length,
              })}
            </span>
          </footer>
        </Show>
      </div>

      <Show when={traceBlock()}>
        {(block) => (
          <TraceDrawer
            block={block()}
            onClose={() => {
              setTraceBlock(null);
              setReplayPos(null);
            }}
          />
        )}
      </Show>
      <Show when={panelOpen() && !traceBlock() && settled(view)}>
        {(v) => {
          const files = () => v().files_changed;
          /** How many files the changes view actually found. */
          const changeCount = () =>
            opencode() ? (reviewDiff() ?? []).filter((f) => f.file).length : files().length;
          /** An empty diff reads differently per baseline, so it says which. */
          const emptyNote = () => t(reviewSource() === "git" ? "review.empty.git" : "review.empty");
          // The list of names is worthless at 288px next to a real diff, so the
          // panel borrows room only while a reader is actually reading one.
          const open = () => files().find((f) => f.path === openFile()) ?? null;
          const toggleFile = (path: string) => setOpenFile(openFile() === path ? null : path);
          const jumpTo = (turnIndex: number) => {
            if (turnIndex >= 0) list?.scrollToIndex(turnIndex);
          };
          return (
            <aside
              class="relative flex shrink-0 flex-col border-l border-border"
              style={{ width: `${railWidth()}px` }}
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("rail.resize")}
                aria-valuemin={RAIL_MIN}
                aria-valuemax={RAIL_MAX}
                aria-valuenow={railWidth()}
                tabindex={0}
                class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:bg-ring/40"
                onPointerDown={startRailDrag}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 48 : 16;
                  if (e.key === "ArrowLeft") resizeRail(railWidth() + step, true);
                  else if (e.key === "ArrowRight") resizeRail(railWidth() - step, true);
                  else return;
                  e.preventDefault();
                }}
              />
              <div
                class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <Show
                  when={opencode()}
                  fallback={
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">
                      {t("panel.changes")}
                      <Show when={changeCount() > 0}>
                        <span class="ml-1 text-2xs font-normal text-muted-foreground">{changeCount()}</span>
                      </Show>
                    </span>
                  }
                >
                  <MiniTabs
                    kind="tabs"
                    value={effectiveTab()}
                    onChange={(id) => selectTab(id as "changes" | "files")}
                    options={[
                      { id: "changes", label: t("panel.changes"), count: changeCount() },
                      { id: "files", label: t("panel.files") },
                    ]}
                    class="min-w-0 flex-1"
                  />
                </Show>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="icon"
                  aria-label={t("panel.hide")}
                  onClick={closePanel}
                >
                  ×
                </Button>
              </div>
              <Show when={effectiveTab() === "files"}>
                <FileBrowser sessionId={props.id} />
              </Show>
              <Show when={effectiveTab() === "changes"}>
                <div class="flex min-h-0 flex-1 flex-col">
                  <Show when={opencode()}>
                    <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
                    <MiniTabs
                      kind="radio"
                      label={t("panel.changes")}
                      value={reviewSource()}
                      onChange={(id) => setReviewSource(id as "session" | "git")}
                      options={[
                        { id: "session", label: t("review.session") },
                        { id: "git", label: t("review.git") },
                      ]}
                      class="shrink-0"
                    />
                    </div>
                  </Show>
                  <Show when={opencode()}>
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                      <Show
                        when={!reviewDiff.loading && !reviewDiff.error}
                        fallback={
                          <p class={`px-3 py-3 text-xs ${reviewDiff.error ? "text-destructive" : "text-muted-foreground"}`}>
                            {reviewDiff.error
                              ? reviewDiff.error instanceof Error
                                ? reviewDiff.error.message
                                : String(reviewDiff.error)
                              : t("review.loading")}
                          </p>
                        }
                      >
                        <Show
                          when={(reviewDiff() ?? []).some((f) => f.file)}
                          fallback={<p class="px-3 py-3 text-xs text-muted-foreground">{emptyNote()}</p>}
                        >
                          <ReviewPane
                            files={reviewDiff() ?? []}
                            layout={reviewLayout()}
                            onLayout={setReviewLayout}
                            onComment={citeLine}
                          />
                        </Show>
                      </Show>
                    </div>
                  </Show>
                  <Show when={!opencode()}>
                    <div class="flex min-h-0 flex-1">
                      <div
                        class={`min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3 ${
                          open() ? "w-44 shrink-0 border-r border-border" : "w-full px-3"
                        }`}
                      >
                        <Show
                          when={files().length > 0}
                          fallback={<p class="px-1 text-xs text-muted-foreground">{t("rail.nothing")}</p>}
                        >
                          <ul class="space-y-0.5">
                            <For each={files()}>
                              {(f) => (
                                <li>
                                  <RowButton
                                    aria-expanded={openFile() === f.path}
                                    onClick={() => toggleFile(f.path)}
                                    title={f.path}
                                    class={`items-baseline gap-2 px-1 py-1 hover:bg-secondary ${
                                      openFile() === f.path ? "bg-secondary" : ""
                                    }`}
                                  >
                                    <span
                                      class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                        f.change === "add"
                                          ? "bg-status-active"
                                          : f.change === "delete"
                                            ? "bg-status-error"
                                            : "bg-status-completed"
                                      }`}
                                      title={changeWord(f.change)}
                                    />
                                    <span class="min-w-0 flex-1">
                                      <span class="block truncate text-sm">{fileName(f.path)}</span>
                                      {/* The word for the change lived here as well as on
                                          the dot. It stays on the dot, where the colour
                                          is, and this line keeps only the one number
                                          that is not already encoded. */}
                                      <Show when={f.count > 1}>
                                        <span class="block truncate text-2xs text-muted-foreground">
                                          {tn("file.changes", f.count)}
                                        </span>
                                      </Show>
                                    </span>
                                    {/* ≥ because a change nothing explained leaves its lines uncounted */}
                                    <span
                                      class="shrink-0 font-mono text-2xs"
                                      title={f.unexplained ? t("file.partial") : undefined}
                                    >
                                      <span class="text-diff-add-fg">
                                        {f.unexplained ? "≥+" : "+"}
                                        {num(f.additions)}
                                      </span>{" "}
                                      <span class="text-diff-del-fg">−{num(f.deletions)}</span>
                                    </span>
                                  </RowButton>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>
                      <Show when={open()}>
                        {(f) => (
                          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                            <div class="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
                              <span class="min-w-0 flex-1 font-mono text-2xs break-all text-muted-foreground">
                                {f().path}
                              </span>
                              <Button
                                type="button"
                                variant="icon"
                                size="xs"
                                class="shrink-0 px-1.5"
                                onClick={() => setOpenFile(null)}
                              >
                                {t("file.close")}
                              </Button>
                            </div>
                            <div class="min-h-0 flex-1 overflow-x-auto overflow-y-auto px-3 py-2">
                              <Show when={f().unexplained}>
                                <p class="mb-2 rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                                  {tn("file.hidden", f().edits.filter((e) => !e.diff).length)}
                                </p>
                              </Show>
                              <For each={f().edits}>
                                {(edit) => (
                                  <section class="mb-3 last:mb-0">
                                    <div class="sticky left-0 mb-1 flex w-max items-center gap-2 bg-background">
                                      <span class="rounded bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
                                        {edit.whole_file ? t("file.whole") : t("file.region")}
                                      </span>
                                      <span class="font-mono text-2xs">
                                        <span class="text-diff-add-fg">+{num(edit.additions)}</span>{" "}
                                        <span class="text-diff-del-fg">−{num(edit.deletions)}</span>
                                      </span>
                                      <Show when={edit.turn_index >= 0}>
                                        <Button
                                          type="button"
                                          variant="icon"
                                          size="xs"
                                          class="ml-auto shrink-0 rounded px-1.5"
                                          onClick={() => jumpTo(edit.turn_index)}
                                        >
                                          {t("file.jump")}
                                        </Button>
                                      </Show>
                                    </div>
                                    <Show
                                      when={edit.diff}
                                      fallback={
                                        <p class="rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                                          {t("file.noDiff")}
                                        </p>
                                      }
                                    >
                                      <DiffBlock patch={edit.diff!} />
                                    </Show>
                                  </section>
                                )}
                              </For>
                            </div>
                          </div>
                        )}
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
            </aside>
          );
        }}
      </Show>
    </div>
  );
}
