import { createSignal, For, Show, type JSX } from "solid-js";
import { backendLabel, fmtUsd, type SessionView } from "./api";
import { Icon } from "./icons";
import { compactNum, num, stamp, t } from "./i18n";
import { copyText } from "./clipboard";
import { sessionNotice, sessionStatus, showsMark, type SessionStatus } from "./session-status";
import { pieSectorPath } from "./context-pie";
import type { SessionContext } from "./prompt-memory";
import { requestParts, type RequestPart, type RequestPartKey } from "./request-usage";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";

/**
 * Context use as a pie gauge rather than a stroked ring: a thin outline for
 * the whole and a filled wedge for the share. The old arc spent its first
 * dozen percent looking like a spinner — a stroke that barely starts is the
 * shape busy indicators are made of, and this is a measure, not motion.
 */
export function ContextRing(props: { percent: number | null }) {
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
      <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.25" />
      <Show when={props.percent != null && props.percent >= 99.5}>
        <circle cx="8" cy="8" r="4.75" fill="currentColor" />
      </Show>
      <Show when={props.percent != null && props.percent >= 0.5 && props.percent < 99.5}>
        <path d={pieSectorPath(props.percent!, 4.75)} fill="currentColor" />
      </Show>
    </svg>
  );
}

/**
 * A filled bar reads faster than the ring once the number is spelled out.
 *
 * The filled part is split into the request's composition, so the gauge answers
 * both "how full" and "of what" at once. The caller supplies the detail behind
 * a hover; the bar itself stays one line tall.
 */
function ContextBar(props: {
  percent: number | null;
  segments?: RequestPart[];
  label?: string;
}) {
  const width = () => `${Math.max(0, Math.min(100, props.percent ?? 0))}%`;
  const tone = () =>
    props.percent == null
      ? "bg-border"
      : props.percent >= 90
        ? "bg-destructive"
        : props.percent >= 75
          ? "bg-status-cancelled"
          : "bg-foreground";
  const split = () => (props.segments?.length ?? 0) > 0;
  return (
    <div
      class="h-1.5 w-full overflow-hidden rounded-full bg-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="img"
      aria-label={props.label}
      tabIndex={props.label ? 0 : undefined}
    >
      <div class="flex h-full overflow-hidden rounded-full transition-[width]" style={{ width: width() }}>
        <Show
          when={split()}
          fallback={<div class={`h-full w-full rounded-full ${tone()}`} />}
        >
          <For each={props.segments}>
            {(segment) => (
              <span
                class={`h-full shrink-0 ${PART_FILL[segment.key]}`}
                style={{ width: `${segment.width}%` }}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/**
 * The request's parts take the chart palette — the split is categorical, not
 * a status, so no colour is allowed to read as a warning or a grade.
 */
const PART_FILL: Record<RequestPartKey, string> = {
  cache_read: "bg-chart-1",
  cache_write: "bg-chart-4",
  input: "bg-chart-2",
  output: "bg-chart-3",
  reasoning: "bg-chart-5",
};

function requestLabel(key: RequestPartKey): string {
  return t(`info.request.${key}`);
}

/**
 * The request's composition as spoken text: the aria label and the plain
 * fallback say the same rows the hover card draws. Every number here is one
 * the backend reported — the card's note says nothing is estimated, so the
 * label must not invent a figure either.
 */
function requestTip(parts: RequestPart[], total: number): string {
  if (parts.length === 0) return "";
  const rows = parts.map((part) => {
    const percent = part.percent < 0.1 ? "<0.1" : part.percent;
    return `${requestLabel(part.key)} ${percent}% · ${num(part.tokens)}`;
  });
  return [`${t("info.request")} · ${num(total)}`, ...rows, t("info.request.note")].join("\n");
}

/**
 * The request's composition behind the bar's hover, laid out as a small
 * table instead of stacked text. Percentages are of `total` — the reported
 * size of the last model call — and the note states that nothing here is
 * estimated.
 */
function RequestCard(props: { parts: RequestPart[]; total: number }) {
  return (
    <div class="w-64">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-xs font-medium text-foreground">{t("info.request")}</span>
        <span class="font-mono text-2xs tabular-nums text-muted-foreground">{num(props.total)}</span>
      </div>
      <div class="mt-2 grid grid-cols-[minmax(0,1fr)_3rem_2.75rem_4rem] items-center gap-x-2 gap-y-1.5">
        <For each={props.parts}>
          {(part) => (
            <>
              <span class="inline-flex min-w-0 items-center gap-1.5">
                <span class={`size-2 shrink-0 rounded-full ${PART_FILL[part.key]}`} />
                <span class="truncate text-xs text-foreground">{requestLabel(part.key)}</span>
              </span>
              <span class="h-1 w-full overflow-hidden rounded-full bg-border">
                <span
                  class={`block h-full rounded-full ${PART_FILL[part.key]}`}
                  style={{ width: `max(2px, ${part.width}%)` }}
                />
              </span>
              <span class="text-right text-xs tabular-nums text-foreground">
                {part.percent < 0.1 ? "<0.1" : part.percent}%
              </span>
              <span class="text-right font-mono text-2xs tabular-nums text-muted-foreground">
                {num(part.tokens)}
              </span>
            </>
          )}
        </For>
      </div>
      <p class="mt-2.5 border-t border-border pt-2 text-2xs leading-4 text-muted-foreground">
        {t("info.request.note")}
      </p>
    </div>
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
  /** The last request's reported usage; undefined when the backend does not
   *  publish one. */
  context: SessionContext | undefined;
  model: string;
  backend: string;
  status: string;
  /** Live generation, so the header says "running" when it is, not when the
   *  backend last wrote a status. */
  busy?: boolean;
  needsInput?: boolean;
  retry?: SessionView["retry"];
  compacting?: boolean;
  sessionError?: SessionView["session_error"];
  workspace?: string;
  branch?: string;
}) {
  const state = () =>
    sessionStatus({
      status: props.status,
      busy: props.busy,
      needs_input: props.needsInput,
      retry: props.retry,
      compacting: props.compacting,
      session_error: props.sessionError,
    });
  const notice = () =>
    sessionNotice({ retry: props.retry, session_error: props.sessionError });
  const parts = () => (props.context ? requestParts(props.context.usage, props.context.total) : []);
  const contextTip = () => requestTip(parts(), props.context?.total ?? 0);
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
            <Tip
              label={contextTip()}
              content={
                parts().length > 0
                  ? () => <RequestCard parts={parts()} total={props.context?.total ?? 0} />
                  : undefined
              }
              class="w-full"
            >
              <ContextBar
                percent={props.context!.percent}
                segments={parts()}
                label={contextTip()}
              />
            </Tip>
          </div>
          <div class="mt-1.5 flex items-baseline justify-between gap-3 text-2xs text-muted-foreground">
            <span>{num(props.context!.total)} tokens</span>
            <Show when={props.context!.limit}>
              <span class="font-mono">{t("info.context.of", { n: num(props.context!.limit!) })}</span>
            </Show>
          </div>
        </Show>
        <Show when={!props.context || props.context.total <= 0}>
          <div class="mt-1 text-2xs text-muted-foreground">{t("info.context.none")}</div>
        </Show>
      </div>

      {/* The status word above names the state; this says why — the failure a
          retry is waiting out, or the error that ended the session. */}
      <Show when={notice()}>
        {(n) => (
          <div
            class={`mt-2.5 rounded-md border px-2.5 py-2 ${
              n().kind === "error"
                ? "border-destructive/40 bg-destructive/10"
                : "border-status-active/40 bg-status-active/10"
            }`}
          >
            <p class={`text-xs ${n().kind === "error" ? "text-destructive" : "text-foreground"}`}>
              {t(n().title.key, n().title.vars)}
            </p>
            <Show when={n().detail}>
              <p class="mt-0.5 break-words text-2xs leading-4 text-muted-foreground">{n().detail}</p>
            </Show>
            <Show when={n().kind === "retry" && n().next !== undefined}>
              <p class="mt-0.5 text-2xs text-muted-foreground">
                {t("session.notice.retry_at", { when: stamp(n().next!) })}
              </p>
            </Show>
          </div>
        )}
      </Show>

      <InfoGroup divided={false}>
        <InfoRow label={t("info.model")} value={props.model || "—"} mono title={props.model} />
        <InfoRow label={t("info.cost")} value={fmtUsd(props.totals.cost_usd)} mono />
        {/* A cache-read count runs to nine digits. Spelled out it is the
            widest thing in the panel and pushes every other row's decimal out
            of alignment; the exact figure stays on hover. */}
        <InfoRow
          label={t("info.total.input")}
          value={compactNum(props.totals.input)}
          mono
          title={num(props.totals.input)}
        />
        <InfoRow
          label={t("info.total.output")}
          value={compactNum(props.totals.output)}
          mono
          title={num(props.totals.output)}
        />
        <Show when={props.totals.reasoning > 0}>
          <InfoRow
            label={t("info.total.reasoning")}
            value={compactNum(props.totals.reasoning)}
            mono
            title={num(props.totals.reasoning)}
          />
        </Show>
        <Show when={props.totals.cache_read > 0}>
          <InfoRow
            label={t("info.total.cache_read")}
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
