import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  browserUse,
  browserWatchUrl,
  readBrowserState,
  sendBrowserInput,
  sendBrowserNavigate,
  type BrowserInputBody,
  type BrowserState,
  type BrowserWatchMeta,
} from "./api";
import { openExternally } from "./external-open";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";

/**
 * The rail's live view of the session's browser: a screencast stream in,
 * pointer and keys back out.
 *
 * Two kinds of target land in the same view — the app's own Chrome pages and
 * whatever the session attached to (an Electron window reads the same once it
 * answers CDP). The pane never navigates on its own; the address field is a
 * direct drive of the same /browser/navigate the agent's tool calls.
 */
export function BrowserPane(props: { sessionId: () => string }) {
  const [state, setState] = createSignal<BrowserState>({ chrome: "off", targets: [] });
  const [meta, setMeta] = createSignal<BrowserWatchMeta>({ page: "", url: "", w: 0, h: 0 });
  const [frame, setFrame] = createSignal<string>();
  const [urlDraft, setUrlDraft] = createSignal("");
  const [navError, setNavError] = createSignal("");
  let img: HTMLImageElement | undefined;
  let box: HTMLDivElement | undefined;
  let es: EventSource | undefined;
  let lastMove = 0;

  const refresh = () =>
    readBrowserState(props.sessionId())
      .then(setState)
      .catch(() => {});

  createEffect(() => {
    const sessionId = props.sessionId();
    setFrame(undefined);
    setMeta({ page: "", url: "", w: 0, h: 0 });
    let closed = false;
    void browserWatchUrl(sessionId).then((url) => {
      if (closed) return;
      es = new EventSource(url);
      es.addEventListener("meta", (e) => {
        const m = JSON.parse((e as MessageEvent).data) as BrowserWatchMeta;
        setMeta(m);
        if (!m.page) setFrame(undefined);
      });
      es.addEventListener("frame", (e) => {
        const data = (JSON.parse((e as MessageEvent).data) as { data: string }).data;
        setFrame(`data:image/jpeg;base64,${data}`);
      });
    });
    refresh();
    // Tabs arrive and leave as the agent works — the stream carries frames,
    // not membership, so the list re-asks on a slow beat.
    const poll = setInterval(refresh, 3_000);
    onCleanup(() => {
      closed = true;
      clearInterval(poll);
      es?.close();
      es = undefined;
    });
  });

  const current = () => state().targets.find((t) => t.current);
  const shownUrl = () => meta().url || current()?.url || "";

  /** Display px in the image to viewport px on the page, via the stream's meta. */
  const viewportPoint = (e: { clientX: number; clientY: number }) => {
    const rect = img?.getBoundingClientRect();
    const m = meta();
    if (!img || !rect || !rect.width || !m.w || !m.h) return undefined;
    return {
      x: Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * m.w)),
      y: Math.max(0, Math.round(((e.clientY - rect.top) / rect.height) * m.h)),
    };
  };
  const send = (input: BrowserInputBody) => {
    void sendBrowserInput(props.sessionId(), input).catch(() => {});
  };
  const sendAt = (
    e: { clientX: number; clientY: number },
    make: (p: { x: number; y: number }) => BrowserInputBody,
  ) => {
    const p = viewportPoint(e);
    if (p) send(make(p));
  };

  const openOutside = () => {
    const url = shownUrl();
    if (!url || !url.startsWith("http")) return;
    void openExternally(url).catch(() => window.open(url, "_blank"));
  };
  const navigate = () => {
    const url = urlDraft().trim();
    if (!url) return;
    sendBrowserNavigate(props.sessionId(), url)
      .then(() => setNavError(""))
      .catch((err) => setNavError(err instanceof Error ? err.message : String(err)));
  };

  const SPECIAL = new Set([
    "Enter", "Backspace", "Escape", "Tab", "Delete", "Insert",
    "Home", "End", "PageUp", "PageDown",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    ...[...Array(12)].map((_, i) => `F${i + 1}`),
  ]);
  const onKey = (e: KeyboardEvent) => {
    // Modifier combos stay the reader's own — Cmd+C is not the page's copy.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      send({ kind: "type", text: e.key });
    } else if (SPECIAL.has(e.key)) {
      send({ kind: "key", key: e.key });
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Icon name="globe" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Show
          when={state().targets.length > 1}
          fallback={
            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={shownUrl()}>
              {shownUrl() || t("browser.none")}
            </span>
          }
        >
          <select
            class="min-w-0 flex-1 rounded bg-secondary px-1 py-0.5 font-mono text-2xs"
            value={current()?.id ?? ""}
            onChange={(e) => void browserUse(props.sessionId(), e.currentTarget.value).then(refresh).catch(() => {})}
          >
            <For each={state().targets}>
              {(tab) => (
                <option value={tab.id}>
                  {tab.id} · {tab.url || tab.source}
                </option>
              )}
            </For>
          </select>
        </Show>
        <Show when={shownUrl().startsWith("http")}>
          <Button
            type="button"
            size="icon-sm"
            variant="icon"
            aria-label={t("browser.external")}
            title={t("browser.external")}
            onClick={openOutside}
          >
            <Icon name="link" class="h-3.5 w-3.5" />
          </Button>
        </Show>
      </div>
      <Show when={state().targets.length > 0}>
        <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <TextFieldInput
            size="sm"
            mono
            bare
            class="min-w-0 flex-1 text-2xs"
            placeholder={t("browser.address")}
            value={urlDraft()}
            onInput={(e) => setUrlDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate();
              e.stopPropagation();
            }}
          />
        </div>
        <Show when={navError()}>
          <p class="shrink-0 truncate px-2 py-1 text-2xs text-destructive" title={navError()}>
            {navError()}
          </p>
        </Show>
      </Show>
      <div
        ref={box}
        tabindex={0}
        class="relative min-h-0 flex-1 select-none overflow-hidden bg-neutral-950 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        onKeyDown={onKey}
      >
        <Show
          when={frame()}
          fallback={
            <p class="px-3 py-3 text-2xs text-muted-foreground">
              {state().targets.length ? t("browser.waiting") : t("browser.empty")}
            </p>
          }
        >
          {(src) => (
            <img
              ref={img}
              src={src()}
              alt=""
              draggable={false}
              class="block w-full cursor-crosshair"
              onPointerDown={(e) => {
                box?.focus();
                img?.setPointerCapture(e.pointerId);
                sendAt(e, (p) => ({ kind: "down", ...p, button: e.button === 2 ? "right" : "left" }));
                e.preventDefault();
              }}
              onPointerUp={(e) =>
                sendAt(e, (p) => ({ kind: "up", ...p, button: e.button === 2 ? "right" : "left" }))
              }
              onPointerMove={(e) => {
                if (e.timeStamp - lastMove < 40) return;
                lastMove = e.timeStamp;
                sendAt(e, (p) => ({ kind: "move", ...p }));
              }}
              onWheel={(e) => {
                sendAt(e, (p) => ({ kind: "wheel", ...p, dx: e.deltaX, dy: e.deltaY }));
                e.preventDefault();
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
