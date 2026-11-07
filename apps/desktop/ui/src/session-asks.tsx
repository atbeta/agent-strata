import { createMemo, createResource, createSignal, type Resource } from "solid-js";
import {
  getJson,
  readSessionPolicy,
  respondPermission,
  setSessionPolicy,
  type PendingAsk,
  type PendingQuestion,
  type SessionView,
} from "./api";
import { t } from "./i18n";
import { fadeSignal } from "./errors";
import { settled } from "./resource";
import { descendantSessions } from "./session-tree";
import { Tip } from "./tip";
import { Icon } from "./icons";
import type { SessionRowSummary } from "./pane-stage";
import { Button } from "@/components/ui/button";

/**
 * What the session is waiting on the reader for: pending permission asks and
 * questions, its own and its subagents', and the switch that stops it asking.
 */
export function useSessionAsks(
  props: { id: string; sessions: SessionRowSummary[] },
  view: Resource<SessionView | undefined>,
  onError: (message: string) => void,
) {
  const [asks, { refetch: refetchAsks }] = createResource(
    () => props.id,
    async () => {
      const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
      return r.pending;
    },
  );
  /**
   * The sessions this one opened, which the sidebar does not show.
   *
   * Their prompts are the reader's to answer all the same: a subagent waiting
   * on an ask stops the conversation they are in, and from here the run simply
   * stops moving. Judged from the list, so a new subagent is picked up the
   * moment it appears.
   */
  const descendants = createMemo(() => descendantSessions(props.sessions, props.id));
  const mine = (sessionId: string) => sessionId === props.id || descendants().has(sessionId);
  /** The subagent's own name, for a card that is not this session's. */
  const asksFrom = (sessionId: string): string | undefined => {
    if (sessionId === props.id) return undefined;
    const row = props.sessions.find((s) => s.summary.session_id === sessionId);
    return row?.title ?? row?.summary.title ?? undefined;
  };
  const [hiddenAsks, setHiddenAsks] = createSignal<ReadonlySet<string>>(new Set());
  const unhideAsk = (request_id: string) =>
    setHiddenAsks((cur) => {
      const next = new Set(cur);
      next.delete(request_id);
      return next;
    });
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => props.id,
    async () => {
      const r = await getJson<{ pending: (PendingQuestion & { session_id: string })[] }>(
        "/questions",
      );
      return r.pending;
    },
  );
  const openQuestions = () => (settled(questions) ?? []).filter((q) => mine(q.session_id ?? props.id));

  /**
   * Whether this session has been told to stop asking.
   *
   * Per session on purpose and not persisted: it is a stance about a
   * conversation in progress, so switching sessions must show what that
   * session is actually doing rather than the last one that was touched.
   *
   * `unknown` is a real answer and not a polite default. A read that failed —
   * a service too old to have the route, a sidecar that has not come up — used
   * to be reported as `inherit`, which drew an ordinary "off" switch and made
   * a broken backend look exactly like a working one. Pressing it then did
   * nothing at all: the write 404'd, the catch undid the flip, and every
   * symptom was the button being dead. Anything unreadable now says so on the
   * button rather than pretending.
   */
  const [autoAccept, { refetch: refetchAutoAccept }] = createResource(
    () => props.id,
    (id) => readSessionPolicy(id).catch(() => "unknown" as const),
  );
  const [autoAcceptErr, setAutoAcceptErr] = fadeSignal("");
  const autoAcceptOn = () => autoAccept() === "auto";
  const toggleAutoAccept = async () => {
    const next = autoAcceptOn() ? "inherit" : "auto";
    setAutoAcceptErr("");
    // Flip the reader's own read first. The route is a local POST and the
    // answer is already known; waiting for it would make the button sit there
    // not having moved, which is how a reader toggles it twice.
    refetchAutoAccept(next);
    // What was already on screen has to follow. A card still waiting while the
    // header says the session is not waiting any more is the same disagreement
    // this whole switch is meant to remove, and it is the one a reader meets
    // first — they are looking at a permission when they reach for the button.
    const held = next === "auto" ? (asks() ?? []).map((a) => a.request_id) : [];
    for (const request_id of held) setHiddenAsks((cur) => new Set(cur).add(request_id));
    try {
      await setSessionPolicy(props.id, next);
      for (const request_id of held) {
        await respondPermission(request_id, "allow", "once").catch((err) => {
          // 404 is already gone. 409 is already being submitted — a second
          // click, or this switch racing the card. Neither is a failure to
          // put back on screen. Anything else is, and the card comes back.
          const settled = err instanceof Error && /\b(404|409)\b/.test(err.message);
          if (!settled) unhideAsk(request_id);
        });
      }
      refetchAutoAccept();
      refetchAsks();
    } catch (err) {
      for (const request_id of held) unhideAsk(request_id);
      setAutoAcceptErr(err instanceof Error ? err.message : String(err));
      refetchAutoAccept();
    }
  };

  const respond = async (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => {
    setHiddenAsks((cur) => new Set(cur).add(requestId));
    try {
      await respondPermission(requestId, decision, scope);
    } catch (err) {
      const missing = err instanceof Error && /\b(404|409)\b/.test(err.message);
      if (!missing) {
        setHiddenAsks((cur) => {
          const next = new Set(cur);
          next.delete(requestId);
          return next;
        });
        onError(err instanceof Error ? err.message : t("err.network"));
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
      if (!mine(ask.session_id)) return false;
      if (hidden.has(ask.request_id) || decided.has(ask.request_id)) return false;
      if (ask.call_id && finished.has(ask.call_id)) return false;
      return true;
    });
  };

  /** A different session: nothing it answered is still being held back. */
  const resetAsks = () => setHiddenAsks(new Set<string>());

  /**
   * The auto-accept switch.
   *
   * It lives in the composer's footer now, beside attach, because that is the
   * question it answers: it decides whether what this message goes out is
   * allowed to run without stopping to ask. The eye is already there, next to
   * the send button the reader is about to press, so "is this one going to ask
   * me?" is answerable before they press it rather than after they scroll back
   * up to a header icon.
   *
   * Amber when it is on, like the permission cards it stands for. Red when the
   * state cannot be read — a switch that might be on and reads as off is the one
   * state worth interrupting the reader for. Unlit when it is off, because off
   * is the ordinary case and should not compete with the send button.
   */
  const autoAcceptToggle = () => (
    <Tip
      label={
        autoAcceptErr() ||
        (autoAccept() === "unknown"
          ? t("header.autoAccept.broken")
          : t(autoAcceptOn() ? "header.autoAccept.on" : "header.autoAccept.off"))
      }
    >
      <Button
        type="button"
        size="icon-sm"
        variant="icon"
        aria-pressed={autoAcceptOn()}
        aria-label={t("header.autoAccept")}
        class={`shrink-0 transition-colors ${
          autoAcceptErr() || autoAccept() === "unknown"
            ? "text-destructive"
            : autoAcceptOn()
              ? "text-event-permission"
              : "text-muted-foreground"
        }`}
        onClick={() => void toggleAutoAccept()}
      >
        <Icon name="shield" class="size-4" />
      </Button>
    </Tip>
  );

  return {
    promptsFailed: () => Boolean(questions.error || asks.error),
    refetchAsks,
    refetchQuestions,
    refetchAutoAccept,
    asksFrom,
    openAsks,
    openQuestions,
    respond,
    resetAsks,
    autoAcceptToggle,
  };
}
