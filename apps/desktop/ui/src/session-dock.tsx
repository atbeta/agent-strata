import { For, Show, type JSX } from "solid-js";
import type { PendingAsk, PendingQuestion } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { contentW } from "./session-chrome";
import { AskCard, QuestionCard } from "./session-prompts";
import { Button } from "@/components/ui/button";

/**
 * What sits under the transcript: the prompts waiting on the reader, the
 * session's standing notices, and the composer, which the session hands in as
 * `children`.
 */
export function SessionDock(props: {
  /** A pending list could not be read. */
  promptsFailed: boolean;
  onRetryPrompts: () => void;
  asks: PendingAsk[];
  questions: (PendingQuestion & { session_id: string })[];
  /** The subagent's own name, for a card that is not this session's. */
  from: (sessionId: string) => string | undefined;
  onRespond: (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => void;
  onQuestionDone: () => void;
  reverted: boolean;
  onRestore: () => void;
  disconnected: boolean;
  children: JSX.Element;
}) {
  return (
    /*
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
    */
    <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-5 pt-6">
      <div class="mx-auto w-full space-y-2" style={{ "max-width": `${contentW()}px` }}>
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
            <Show when={props.promptsFailed}>
              <div class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                <span class="flex h-[1lh] shrink-0 items-center text-destructive">
                  <Icon name="alert" class="size-3.5" />
                </span>
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
                  onClick={props.onRetryPrompts}
                >
                  {t("session.retry")}
                </Button>
              </div>
            </Show>
            <For each={props.asks}>
              {(p) => (
                <AskCard
                  ask={p}
                  from={props.from(p.session_id)}
                  onRespond={(id, decision, scope) => props.onRespond(id, decision, scope)}
                />
              )}
            </For>
            <For each={props.questions}>
              {(q) => (
                <QuestionCard
                  q={q}
                  from={props.from(q.session_id)}
                  onDone={props.onQuestionDone}
                />
              )}
            </For>
          </div>
        </div>
        <Show when={props.reverted}>
          <div class="flex items-center justify-between gap-2 px-1">
            <span class="text-2xs text-muted-foreground">{t("message.reverted")}</span>
            <Button
              type="button"
              variant="quiet"
              size="xs"
              class="h-auto px-0 py-0"
              onClick={props.onRestore}
            >
              {t("message.restore")}
            </Button>
          </div>
        </Show>
        <Show when={props.disconnected}>
          <p class="mb-1.5 flex items-center gap-1.5 px-1 text-2xs text-status-cancelled">
            <Icon name="plug" class="size-3 shrink-0" />
            {t("composer.disconnected")}
          </p>
        </Show>
        {props.children}
      </div>
    </div>
  );
}
