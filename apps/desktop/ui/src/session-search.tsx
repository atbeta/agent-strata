import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { searchSession, type SearchHit, type SessionView } from "./api";
import { settled } from "./resource";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { TextFieldInput } from "@/components/ui/text-field";

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

// Full-text search inside the open session. This is not a convenience: the
// transcript is windowed, so the reader's own Ctrl+F only sees the rows that
// happen to be mounted. Searching has to go to the index to reach the rest.
export function useSessionSearch(args: {
  sessionId: () => string;
  view: () => SessionView | undefined;
  scrollToIndex: (i: number) => void;
  /** called when the search opens, so a sibling popover can step aside */
  onOpen?: () => void;
}) {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hitAt, setHitAt] = createSignal(0);
  const [probe, setProbe] = createSignal("");
  /** A search opened from a global hit lands on its first match, not on the tail. */
  const [jumpFirst, setJumpFirst] = createSignal(false);
  let searchEl: HTMLInputElement | undefined;
  let resultsEl: HTMLUListElement | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(probeTimer));

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
    setJumpFirst(false);
  };

  const [result] = createResource(
    () => (searchOpen() && probe() ? { id: args.sessionId(), q: probe() } : null),
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
    const turns = args.view()?.turns;
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
      const k = args.view()?.turns[at]?.turn_id ?? `#${h.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ hit: h, at });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.hit);
  });

  const goTo = (h: SearchHit | undefined) => {
    const i = h ? turnIndexOf(h) : -1;
    if (i >= 0) args.scrollToIndex(i);
  };

  // The view may still be loading when the search opens. The first match is
  // taken as soon as it exists, not only on the render that opened the panel.
  createEffect(() => {
    if (!jumpFirst()) return;
    const first = targets()[0];
    if (!first) return;
    setJumpFirst(false);
    goTo(first);
  });

  /** Turns are addressed by an opaque id, so a result has to say which one it is. */
  const turnNumber = (h: SearchHit) => turnIndexOf(h) + 1;

  const step = (delta: number) => {
    const all = targets();
    if (!all.length) return;
    const next = Math.max(0, Math.min(all.length - 1, hitAt() + delta));
    setHitAt(next);
    goTo(all[next]);
  };

  const openSearch = (keep?: string, jumpToFirst = false) => {
    args.onOpen?.();
    setSearchOpen(true);
    setJumpFirst(jumpToFirst);
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

  return {
    searchOpen,
    query,
    probe,
    hitAt,
    setHitAt,
    result,
    targets,
    goTo,
    turnNumber,
    step,
    openSearch,
    closeSearch,
    onQuery,
    bindInput: (el: HTMLInputElement) => (searchEl = el),
    bindResults: (el: HTMLUListElement) => (resultsEl = el),
    focusInput: () => searchEl?.focus(),
  };
}

export function SearchPanel(props: {
  search: ReturnType<typeof useSessionSearch>;
  /** the body counts as inside itself, so a dismiss elsewhere leaves it be */
  bindPanel: (el: HTMLDivElement | undefined) => void;
}) {
  const s = () => props.search;
  return (
    <div
      ref={props.bindPanel}
      class="absolute right-4 top-11 z-30 w-[26rem] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <div class="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="search" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <TextFieldInput
          ref={s().bindInput}
          bare
          class="min-w-0 flex-1"
          placeholder={t("session.search.placeholder")}
          value={s().query()}
          onInput={(e) => s().onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              s().step(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              s().closeSearch();
            }
          }}
        />
        <Show when={s().probe()}>
          <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
            {s().result.loading
              ? "…"
              : s().targets().length
                ? `${s().hitAt() + 1}/${s().targets().length}${s().result()?.more ? "+" : ""}`
                : t("session.search.counter.none")}
          </span>
        </Show>
        <Button
          type="button"
          size="icon-xs"
          variant="icon"
          aria-label={t("session.search.prev")}
          disabled={!s().targets().length}
          onClick={() => s().step(-1)}
        >
          <Icon name="chevron" class="h-3.5 w-3.5 rotate-180" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="icon"
          aria-label={t("session.search.next")}
          disabled={!s().targets().length}
          onClick={() => s().step(1)}
        >
          <Icon name="chevron" class="h-3.5 w-3.5" />
        </Button>
      </div>

      <Show
        when={s().targets().length > 0}
        fallback={
          <Show when={s().probe() && !s().result.loading}>
            <p class="px-3 py-4 text-center text-xs text-muted-foreground">
              {t("session.search.empty")}
            </p>
          </Show>
        }
      >
        <ul ref={s().bindResults} class="max-h-72 overflow-x-hidden overflow-y-auto py-1">
          <For each={s().targets()}>
            {(h, i) => (
              <li>
                <RowButton
                  data-hit={i()}
                  // `items-stretch` is not decoration: the base row is a
                  // horizontal flex box, and a column box would centre its
                  // snippet horizontally without it.
                  class={`flex-col items-stretch gap-0.5 px-3 ${
                    i() === s().hitAt() ? "bg-secondary" : ""
                  }`}
                  active={i() === s().hitAt()}
                  onClick={() => {
                    s().setHitAt(i());
                    s().goTo(h);
                  }}
                >
                  <Snippet text={h.snippet} />
                  <span class="font-mono text-2xs text-muted-foreground">
                    {t("session.search.turn", { n: s().turnNumber(h) })}
                  </span>
                </RowButton>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
