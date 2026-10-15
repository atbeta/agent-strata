import { createSignal, Show, type JSX } from "solid-js";
import {
  backendLabel,
  fmtUsd,
  STATUS_DOT,
  STATUS_LABEL,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { compactNum, num, t } from "./i18n";
import { copyText } from "./clipboard";
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
export function SessionInfo(props: {
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
