import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  abortSession,
  findFiles,
  revertSession,
  runCommand,
  sendPrompt,
  type CommandInfo,
  type OptionsResponse,
  type SessionCapabilities,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { num, t, tn } from "./i18n";
import { Tip } from "./tip";
import { planVisible } from "./plan-progress";
import { PlanStrip } from "./plan-strip";
import { runInProgress, SEND_GRACE_MS } from "./live";
import { stopConfirmed } from "./stop-verdict";
import { ComposerToolbar } from "./composer-toolbar";
import { withEcho, type PendingEcho } from "./prompt-echo";
import {
  navigateHistory,
  readDraft,
  readHistory,
  rememberPrompt,
  sessionContext,
  writeDraft,
  writeHistory,
} from "./prompt-memory";
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
import { ContextRing, SessionInfo } from "./session-info";
import { paneWorkspace } from "./session-chrome";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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

export function useSessionComposer(args: {
  sessionId: () => string;
  /** the settled session view; undefined while booting or on error */
  view: () => SessionView | undefined;
  booting: () => boolean;
  caps: () => SessionCapabilities | undefined;
  commands: () => CommandInfo[] | undefined;
  /** runs a `source: "builtin"` entry; the backend owns the rest of the list */
  onBuiltin: (name: string, args: string) => void | Promise<void>;
  options: () => OptionsResponse | undefined;
  replayPos: () => number | null;
  refreshView: (full?: boolean) => Promise<void>;
  /** the git branch, for the details popover — the header chip hides when narrow */
  branch?: () => string | undefined;
}) {
  const opencode = () => args.caps()?.extension === "opencode";

  const [draft, setDraft] = createSignal(readDraft(args.sessionId()));
  const [queued, setQueued] = createSignal<Outgoing[]>([]);
  const [histIndex, setHistIndex] = createSignal(-1);
  const [histSaved, setHistSaved] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");
  /** a one-line confirmation for a built-in command that succeeded quietly (share, …) */
  const [notice, setNotice] = createSignal("");
  /**
   * When the backend last took a prompt off our hands.
   *
   * A handover window, not a flag. It opens the moment Enter is pressed so the
   * next send queues rather than going out beside it, and it opens again when
   * the POST lands, because that is the moment the handover is really done and
   * the wait is now for the projection to say `busy`. See `runInProgress`.
   */
  const [handover, setHandover] = createSignal<number>();
  const [modelSel, setModelSel] = createSignal("");
  const [agentSel, setAgentSel] = createSignal("");
  const [variantSel, setVariantSel] = createSignal("");
  const [modelTouched, setModelTouched] = createSignal(false);
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
  let fileInput: HTMLInputElement | undefined;

  const citeLine = (note: string) => {
    setDraft((cur) => (cur && !cur.endsWith("\n") ? `${cur}\n${note}` : `${cur}${note}`));
    draftEl?.focus();
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
    return tr.kind === "file" ? opencode() : Array.isArray(args.commands());
  };

  createEffect(() => {
    const tr = trigger();
    if (!tr || tr.kind !== "command") return;
    const list = matchCommands(args.commands() ?? [], tr.query).slice(0, 50);
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
      void findFiles(args.sessionId(), tr.query, ctl.signal)
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
  const canAttach = () => args.caps()?.attachments === true;

  const generating = () => runInProgress({ handover: handover(), busy: args.view()?.busy });

  /**
   * The handover deadline, so it cannot outlive the run it was opened for.
   *
   * Timed rather than left to an event because the event it waits for is the
   * one that may never come: the backend saying idle is the ordinary way out,
   * and a session that finished without saying so has no other signal to give.
   * This is the backstop, so it is armed on the way in rather than trusted to
   * be cleared on the way out.
   */
  let handoverTimer: ReturnType<typeof setTimeout> | undefined;
  const openHandover = () => {
    clearTimeout(handoverTimer);
    handoverTimer = undefined;
    // The projection already says the session is running — the backend can mark
    // it busy before the POST that handed it the prompt comes back. There is
    // nothing left for a window to cover, and holding one anyway would be the
    // two latches again, just narrower.
    if (args.view()?.busy === true) {
      setHandover(undefined);
      return;
    }
    handoverTimer = setTimeout(() => setHandover(undefined), SEND_GRACE_MS);
    setHandover(Date.now());
  };
  const closeHandover = () => {
    clearTimeout(handoverTimer);
    handoverTimer = undefined;
    setHandover(undefined);
  };
  onCleanup(closeHandover);

  // The projection has caught up with the handover, so `busy` is the only word
  // left and it changes for honest reasons. Without this the two sat OR-ed
  // together for the life of the session, and a `busy` that recovered on a
  // re-fetch still left the composer queueing.
  createEffect(() => {
    if (args.view()?.busy === true) closeHandover();
  });

  createEffect(() => {
    const agents = args.options()?.agents ?? [];
    if (!agentSel() && agents[0]) setAgentSel(agents[0].name);
  });

  createEffect(() => {
    if (modelTouched()) return;
    const inherited = sessionModel(args.view());
    if (inherited) {
      setModelSel(inherited);
      return;
    }
    if (args.booting() || !args.view()) return;
    const models = args.options()?.models ?? [];
    if (models[0]) setModelSel(`${models[0].providerID}/${models[0].modelID}`);
  });

  const selectedModel = () =>
    args.options()?.models.find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  // empty model means "server default"; still offer that leading model's efforts
  const effortModel = () =>
    selectedModel() ?? args.options()?.models.find((m) => (m.variants?.length ?? 0) > 0);
  const modelOptions = () => {
    const models = args.options()?.models ?? [];
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

  const deliver = async (out: Outgoing) => {
    setSendErr("");
    // A confirmation about the run that just ended says nothing about the one
    // starting, and two of them stacked read as a session stopped twice.
    setStopped(false);
    openHandover();
    setHistIndex(-1);
    // The reader's own sentence goes on screen now. Until the store's turn
    // count passes this baseline, `turns()` draws it in place of a turn the
    // backend has not produced yet; a send that fails clears it below, and a
    // send that succeeds clears it by itself.
    setEcho({ base: args.view()?.turns.length ?? 0, text: out.text });
    if (out.text) writeHistory(rememberPrompt(readHistory(), out.text));
    const chosen = selectedModel();
    const implied = !chosen && variantSel() ? effortModel() : undefined;
    const source = chosen ?? implied;
    const model = source
      ? { providerID: source.providerID, modelID: source.modelID }
      : splitModel(modelSel());
    const choice = { model, agent: agentSel() || undefined, variant: variantSel() || undefined };
    const command = args.caps()?.commands ? commandOf(out.text, (args.commands() ?? []).map((c) => c.name)) : undefined;
    try {
      if (out.revertTurnId) {
        try {
          await revertSession(args.sessionId(), out.revertTurnId);
        } catch (err) {
          // A later edit owns the signal now; don't overwrite it with this failure.
          if (editTurnId() === undefined) setEditTurnId(out.revertTurnId);
          throw err;
        }
      }
      if (command) {
        await runCommand(args.sessionId(), { ...command, parts: commandParts(out.text, out.picked, out.attachments) }, choice);
      } else {
        await sendPrompt(args.sessionId(), promptParts(out.text, out.picked, out.attachments), choice);
      }
      // The backend has it now. The handover that mattered — "the reader gave
      // this over and nothing has come back" — is over; what is left is the
      // projection catching up, so the window restarts from here rather than
      // from the press.
      openHandover();
    } catch (err) {
      setSendErr(explainSend(err instanceof Error ? err.message : "", t("err.send")));
      const back = restoreFailed(out, { text: draft(), picked: picked(), attachments: attachments() });
      setDraft(back.draft.text);
      setPicked(back.draft.picked);
      setAttachments(back.draft.attachments);
      if (back.dropped) setAttachErr(t("composer.attach.too_many", { n: MAX_ATTACHMENTS }));
      setQueuePaused(true);
      closeHandover();
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
    setNotice("");
    setTrigger(undefined);
    if (draftEl) draftEl.style.height = "auto";
    const named = commandOf(out.text, (args.commands() ?? []).map((c) => c.name));
    if (named && (args.commands() ?? []).find((c) => c.name === named.name)?.source === "builtin") {
      // A built-in acts on the session as it stands — it does not queue behind
      // a run in progress, and it sends nothing the transcript would echo.
      if (out.text) writeHistory(rememberPrompt(readHistory(), out.text));
      setHistIndex(-1);
      void Promise.resolve(args.onBuiltin(named.name, named.args)).catch((err) => {
        setSendErr(explainSend(err instanceof Error ? err.message : "", t("err.send")));
        // the command never left, so the draft gets it back like a failed send
        if (!draft().trim()) setDraft(out.text);
      });
      return;
    }
    if (generating()) {
      setQueued((q) => [...q, out]);
      setHistIndex(-1);
      return;
    }
    void deliver(out);
  };
  const canSend = () => Boolean(draft().trim()) || attachments().length > 0;

  // A follow-up typed while the agent is running waits here, then goes out
  // on the next idle. deliver() opens the handover in the same turn, so this
  // does not drain the rest of the queue until that turn finishes.
  createEffect(() => {
    if (generating() || args.replayPos() !== null || queuePaused()) return;
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
    const model = (args.options()?.models ?? []).find((m) => `${m.providerID}/${m.modelID}` === id);
    return sessionContext(args.view()?.turns ?? [], model?.context);
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
        <Show when={args.view()}>
          {(v) => (
            <SessionInfo
              id={args.sessionId()}
              totals={v().totals}
              context={context()}
              model={modelSel()}
              backend={v().backend}
              status={v().status}
              workspace={v().workspace}
              branch={args.branch?.()}
            />
          )}
        </Show>
      </PopoverContent>
    </Popover>
  );
  const modelAvailable = () =>
    (args.options()?.models.length ?? 0) > 0 && (Boolean(modelSel()) || !args.booting());
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
      options={(args.options()?.agents ?? []).map((a) => ({ value: a.name, label: a.name }))}
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
    // Before the request, not after it. The handover says "the reader handed a
    // prompt over and nothing has come back yet", and pressing stop makes that
    // untrue the moment the reader presses it — the prompt is no longer waiting
    // on anything. It used to be cleared after `await abortSession`, which put a
    // network round trip between pressing the button and the session reading as
    // not generating; on a long session, where the view behind it is a full
    // re-fetch, that round trip is long enough for the watchdog to fire first and
    // report a stop that worked as one that did not.
    closeHandover();
    try {
      await abortSession(args.sessionId());
      // The backend returns once it has taken the abort, which is the strongest
      // confirmation available: a 502 means it did not, and says so. Re-reading
      // the view is the cross-check, not the primary evidence.
      setAbortAccepted(true);
      void args.refreshView(false);
    } catch (err) {
      setStopping(false);
      setSendErr(explainSend(err instanceof Error ? err.message : "", t("err.abort")));
    }
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

  createEffect(() => writeDraft(args.sessionId(), draft()));

  // A restored draft arrives with a collapsed textarea; grow it once it exists.
  onMount(() => {
    if (draft()) queueMicrotask(autogrow);
  });

  /** the session behind the composer changed — drop everything that belonged to the old one */
  const resetFor = (id: string) => {
    setDraft(readDraft(id));
    setQueued([]);
    setHistIndex(-1);
    setHistSaved("");
    setSendErr("");
    setNotice("");
    closeHandover();
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
    setTrigger(undefined);
    queueMicrotask(autogrow);
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
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
      const names = (args.options()?.agents ?? []).map((a) => a.name);
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
  };

  return {
    draft,
    setDraft,
    queued,
    setQueued,
    sendErr,
    setSendErr,
    notice,
    setNotice,
    echo,
    generating,
    canSend,
    send,
    stop,
    stopping,
    stopped,
    attachErr,
    attachments,
    addFiles,
    canAttach,
    menuOpen,
    menuItems,
    menuActive,
    setMenuActive,
    menuHint,
    menuId,
    trigger,
    setTrigger,
    setHistIndex,
    pick,
    track,
    autogrow,
    citeLine,
    editTurn,
    editQueued,
    contextSlot,
    modelAvailable,
    modelSlot,
    effortSlot,
    agentSlot,
    agentSel,
    setAgentSel,
    context,
    modelSel,
    clearPending: closeHandover,
    resetFor,
    onKeyDown,
    bindDraft: (el: HTMLTextAreaElement) => (draftEl = el),
    bindFileInput: (el: HTMLInputElement) => (fileInput = el),
    openFilePicker: () => fileInput?.click(),
    removeAttachment: (id: string) => {
      setAttachErr("");
      setAttachments((l) => l.filter((a) => a.id !== id));
    },
    optionsAgents: () => args.options()?.agents.length ?? 0,
    effortVariants: () => effortModel()?.variants?.length ?? 0,
    decorateTurns: (turns: SessionView["turns"]) => withEcho(turns, echo()),
  };
}

export type SessionComposerCtl = ReturnType<typeof useSessionComposer>;

export function SessionComposer(props: {
  c: SessionComposerCtl;
  sessionId: () => string;
  plan: SessionView["plan"];
  title: string | undefined;
}) {
  const c = () => props.c;
  const placeholder = () =>
    paneWorkspace().mode === "multiplex"
      ? c().generating()
        ? t("pane.composer.queue_target", { title: props.title ?? t("session.untitled") })
        : t("pane.composer.target", { title: props.title ?? t("session.untitled") })
      : c().generating()
        ? t("composer.placeholder.queue")
        : t("composer.placeholder.message");
  return (
    <>
      <div class="relative">
        <Show when={c().menuOpen()}>
          <ComposerMenu
            id={c().menuId}
            kind={c().trigger()?.kind ?? "file"}
            items={c().menuItems()}
            active={c().menuActive()}
            hint={c().menuHint()}
            onPick={c().pick}
            onHover={c().setMenuActive}
          />
        </Show>
        <Show when={planVisible(props.plan, c().generating())}>
          <PlanStrip sessionId={props.sessionId()} plan={props.plan!} generating={c().generating()} />
        </Show>
        <Show when={c().queued().length > 0}>
          <div
            class={`border border-b-0 bg-secondary/70 px-3 pb-4 pt-2 ${
              planVisible(props.plan, c().generating())
                ? "border-input border-t-input/60"
                : "rounded-t-2xl border-input"
            }`}
          >
            <p class="text-2xs font-medium text-muted-foreground">
              {tn("composer.queued", c().queued().length)}
            </p>
            <ul class="mt-1 space-y-1">
              <For each={c().queued()}>
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
                      onClick={() => c().editQueued(i())}
                    >
                      {t("composer.edit")}
                    </Button>
                    <Button
                      type="button"
                      size="icon-2xs"
                      variant="icon"
                      class="hover:bg-background"
                      aria-label={t("composer.remove_queued")}
                      onClick={() => c().setQueued((q) => q.filter((_, n) => n !== i()))}
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
          class={`@container/composer surface-composer rounded-2xl border border-transparent bg-card transition-colors focus-within:border-ring ${c().queued().length > 0 || planVisible(props.plan, c().generating()) ? "-mt-2" : ""}`}
          onDragOver={(e) => {
            if (!c().canAttach() || !e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            if (!c().canAttach() || !e.dataTransfer?.files.length) return;
            e.preventDefault();
            void c().addFiles(e.dataTransfer.files);
          }}
        >
          <Show when={c().attachments().length}>
            <AttachmentStrip items={c().attachments()} onRemove={c().removeAttachment} />
          </Show>
          <textarea
            ref={c().bindDraft}
            class="max-h-56 w-full resize-none bg-transparent px-4 py-3 font-sans text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
            rows={1}
            placeholder={placeholder()}
            aria-label={placeholder()}
            value={c().draft()}
            aria-autocomplete="list"
            aria-controls={c().menuOpen() && c().menuItems().length ? c().menuId : undefined}
            aria-activedescendant={
              c().menuOpen() && c().menuItems().length ? `${c().menuId}-${c().menuActive()}` : undefined
            }
            onInput={(e) => {
              c().setDraft(e.currentTarget.value);
              c().setHistIndex(-1);
              c().autogrow();
              if (!e.isComposing) c().track();
            }}
            onCompositionEnd={c().track}
            onClick={c().track}
            onBlur={() => c().setTrigger(undefined)}
            onKeyUp={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") c().track();
            }}
            onPaste={(e) => {
              // Office copies a selection as text plus a picture of it
              if (c().canAttach() && e.clipboardData?.files.length && !e.clipboardData.getData("text/plain")) {
                e.preventDefault();
                void c().addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={c().onKeyDown}
          />
          <Show when={c().canAttach()}>
            <input
              ref={c().bindFileInput}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              class="hidden"
              onChange={(e) => {
                const input = e.currentTarget;
                if (input.files) void c().addFiles(input.files);
                input.value = "";
              }}
            />
          </Show>
          <ComposerToolbar
            context={c().contextSlot}
            agent={c().optionsAgents() > 0 ? c().agentSlot : undefined}
            model={c().modelAvailable() ? c().modelSlot : undefined}
            effort={c().effortVariants() > 0 ? c().effortSlot : undefined}
            onAttach={c().canAttach() ? c().openFilePicker : undefined}
            generating={c().generating()}
            stopping={c().stopping()}
            canSend={c().canSend()}
            onSend={c().send}
            onStop={() => void c().stop()}
          />
        </div>
      </div>
      <Show when={c().sendErr()}>
        <p class="font-mono text-2xs text-destructive">{c().sendErr()}</p>
      </Show>
      <Show when={c().notice()}>
        <p class="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <Icon name="check" class="size-3 shrink-0" />
          {c().notice()}
        </p>
      </Show>
      {/* The stop landed. Without this the button flips back to
          Send and the transcript shows a turn that simply ends,
          which is the same picture as a stop that did nothing. */}
      <Show when={c().stopped()}>
        <p class="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <Icon name="stop" class="size-3 shrink-0" />
          {t("stop.done")}
        </p>
      </Show>
      <Show when={c().attachErr()}>
        <p class="font-mono text-2xs text-destructive">{c().attachErr()}</p>
      </Show>
    </>
  );
}
