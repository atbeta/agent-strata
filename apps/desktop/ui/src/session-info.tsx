import { createSignal, For, Show, type JSX } from "solid-js";
import { backendLabel, fmtUsd, type SessionView } from "./api";
import { Icon } from "./icons";
import { compactNum, num, t } from "./i18n";
import { copyText } from "./clipboard";
import { sessionStatus, showsMark, type SessionStatus } from "./session-status";
import type { ContextBreakdownKey, ContextBreakdownSegment } from "./session-context-breakdown";
import { Button } from "@/components/ui/button";

export function ContextRing(props: { percent: number | null }) {
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

/**
 * The four buckets keep the transcript's own colours — user, assistant, tool —
 * so a reader can connect a share to the kind of row it came from. `other` is
 * deliberately the only grey one: it is the part of the request the log does
 * not hold (system prompt, tool definitions, overhead), not a fourth kind of
 * message.
 */
const BREAKDOWN_FILL: Record<ContextBreakdownKey, string> = {
  user: "bg-event-user",
  assistant: "bg-event-assistant",
  tool: "bg-event-tool",
  other: "bg-muted-foreground/60",
};

function breakdownLabel(key: ContextBreakdownKey): string {
  if (key === "user") return t("info.breakdown.user");
  if (key === "assistant") return t("info.breakdown.assistant");
  if (key === "tool") return t("info.breakdown.tool");
  return t("info.breakdown.other");
}

/**
 * A composition bar for the input side of the last request. Percentages are of
 * `input`, not of the context total — the same denominator OpenCode's desktop
 * uses — so the segments always add up to the number on the right.
 */
function ContextBreakdown(props: { segments: ContextBreakdownSegment[]; input: number }) {
  return (
    <Show when={props.segments.length > 0}>
      <div class="mt-2.5 border-t border-border/60 pt-2">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-2xs text-muted-foreground" title={t("info.breakdown.note")}>
            {t("info.breakdown")}
          </span>
          <span class="font-mono text-2xs tabular-nums text-muted-foreground">
            {t("info.breakdown.input", { n: num(props.input) })}
          </span>
        </div>
        <div class="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
          <For each={props.segments}>
            {(segment) => (
              <span
                class={`h-full shrink-0 ${BREAKDOWN_FILL[segment.key]}`}
                style={{ width: `${segment.width}%` }}
              />
            )}
          </For>
        </div>
        <div class="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
          <For each={props.segments}>
            {(segment) => (
              <span class="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                <span
                  class={`size-1.5 shrink-0 rounded-full ${BREAKDOWN_FILL[segment.key]}`}
                  aria-hidden="true"
                />
                <span class="truncate">{breakdownLabel(segment.key)}</span>
                <span class="tabular-nums text-muted-foreground/70">
                  {segment.percent < 0.1 ? "<0.1" : segment.percent}%
                </span>
              </span>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

/**
 * A label on the left, a value on the right. The value is allowed to truncate
 * rather than push the label off the row — a model id or a workspace path is
 * longer than the panel is wide — and the full text stays on `title`.
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

/**
 * A band of related rows. These two bands need no caption: every row names
 * what it is, and "用量" over a list that starts with 模型 and ends with
 * 工具调用 told the reader nothing the rows did not. Only the band that opens
 * a new kind of fact (identity, after the numbers) draws a rule; the context
 * card's own edge already closes the block above the first one.
 */
function InfoGroup(props: { divided?: boolean; children: JSX.Element }) {
  return (
    <section
      class={
        props.divided === false
          ? "mt-2.5"
          : "mt-2.5 border-t border-border pt-2.5"
      }
    >
      {props.children}
    </section>
  );
}

/** A status, as the rest of the app draws one: a mark and the word beside it.
 *  The word is always spelled out here because the panel has the room; only
 *  the two states that ask something of the reader take a colour. */
function StatusValue(props: { status: SessionStatus }) {
  const tone = () =>
    props.status.kind === "failed"
      ? "text-status-error"
      : props.status.kind === "needs-input"
        ? "text-event-permission"
        : "text-muted-foreground";
  return (
    <span class="inline-flex min-w-0 items-center gap-1.5">
      <Show when={showsMark(props.status)}>
        <span class={`size-1.5 shrink-0 rounded-full ${props.status.tone.dot}`} />
      </Show>
      <span class={`truncate ${tone()}`}>{t(props.status.label)}</span>
    </span>
  );
}

/**
 * The context ring, made into the entry point for everything about the session
 * that is not the transcript: context use, token breakdown, and cost. Cost
 * used to sit in the header as bare text where it read as clutter next to the
 * window caption; here it has room to be a real number.
 */
export function SessionInfo(props: {
  id: string;
  totals: SessionView["totals"];
  context: { total: number; percent: number | null; input: number } | undefined;
  /** Estimated input composition; empty when the last step spent no input. */
  breakdown?: ContextBreakdownSegment[];
  model: string;
  backend: string;
  status: string;
  /** Live generation, so the header says "running" when it is, not when the
   *  backend last wrote a status. */
  busy?: boolean;
  needsInput?: boolean;
  workspace?: string;
  branch?: string;
}) {
  const state = () =>
    sessionStatus({ status: props.status, busy: props.busy, needs_input: props.needsInput });
  const contextLimit = () => {
    // A session that has sent tokens but rounds to 0% has no window to infer:
    // dividing by it would print an infinite limit.
    if (
      !props.context ||
      props.context.percent == null ||
      props.context.percent <= 0 ||
      props.context.total <= 0
    )
      return null;
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
    <div class="w-80">
      <div class="mb-2.5 flex items-center justify-between gap-3">
        <span class="text-sm font-medium">{t("info.session")}</span>
        <span class="text-2xs">
          <StatusValue status={state()} />
        </span>
      </div>

      <div class="rounded-lg border border-border bg-secondary/40 p-3">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs text-muted-foreground">{t("info.context")}</span>
          <span class="font-mono text-xs tabular-nums text-foreground">
            {props.context
              ? props.context.percent == null
                ? `${num(props.context.total)} tokens`
                : `${props.context.percent}%`
              : "—"}
          </span>
        </div>
        {/* A percentage is the bar's reason to exist. With no reported window
            (a backend that sends tokens but no limit) an empty track reads as
            "none used", which is the opposite of 148k tokens. Spelled out,
            there is nothing to misread. */}
        <Show when={props.context?.percent != null}>
          <div class="mt-2">
            <ContextBar percent={props.context!.percent} />
          </div>
          <div class="mt-1.5 flex items-baseline justify-between gap-3 text-2xs text-muted-foreground">
            <span>{num(props.context!.total)} tokens</span>
            <Show when={contextLimit()}>
              <span class="font-mono">{t("info.context.of", { n: num(contextLimit()!) })}</span>
            </Show>
          </div>
        </Show>
        <Show when={!props.context || props.context.total <= 0}>
          <div class="mt-1 text-2xs text-muted-foreground">{t("info.context.none")}</div>
        </Show>
        <ContextBreakdown segments={props.breakdown ?? []} input={props.context?.input ?? 0} />
      </div>

      <InfoGroup divided={false}>
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

      <InfoGroup>
        <InfoRow label={t("info.backend")} value={backendLabel(props.backend)} />
        <Show when={props.workspace}>
          <InfoRow label={t("info.workspace")} value={props.workspace!} mono title={props.workspace} />
        </Show>
        <Show when={props.branch}>
          <InfoRow label={t("info.branch")} value={props.branch!} mono title={props.branch} />
        </Show>
        {/* The id is the one row here that does something, so it is a row-shaped
            target with a hover fill and an inset ring, not a link-sized text
            button. Full width means the affordance reaches the eye before the
            pointer does, and the ring lands on the row instead of on 16px of
            mono text. */}
        <div class="-mx-1.5">
          <Button
            type="button"
            variant="quiet"
            size="xs"
            class="group h-auto w-full justify-between gap-3 px-1.5 py-1 text-xs text-foreground hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-inset"
            title={props.id}
            aria-label={t("info.id.copy")}
            onClick={() => void copyId()}
          >
            <span class="shrink-0 text-muted-foreground">{t("info.id")}</span>
            <span class="flex min-w-0 items-center gap-1.5 font-mono">
              <span class="truncate">
                <span class="text-muted-foreground">{idParts()[0]}</span>
                {idParts()[1]}
              </span>
              <Icon
                name={idCopied() ? "check" : "copy"}
                class={`size-3 shrink-0 ${
                  idCopied()
                    ? "text-status-active"
                    : "text-muted-foreground/70 group-hover:text-foreground"
                }`}
              />
            </span>
          </Button>
          <span class="sr-only" aria-live="polite">
            {idCopied() ? t("info.id.copied") : ""}
          </span>
        </div>
      </InfoGroup>
    </div>
  );
}
