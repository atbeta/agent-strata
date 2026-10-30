import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import {
  abortSession,
  findFiles,
  revertSession,
  runCommand,
  runShell,
  sendPrompt,
  type CommandInfo,
  type OptionsResponse,
  type SessionCapabilities,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { num, t, tn } from "./i18n";
import { displayTitle } from "./session-title";
import { Tip } from "./tip";
import { planVisible } from "./plan-progress";
import { PlanStrip } from "./plan-strip";
import { GoalButton, GoalStrip, useGoal } from "./goal-bar";
import { runInProgress, SEND_GRACE_MS } from "./live";
import { createSessionStop } from "./session-stop";
import { ComposerToolbar } from "./composer-toolbar";
import { createComposerDelivery } from "./composer-delivery";
import { createSessionQueues, persistSessionQueues, restoreColdDraft } from "./composer-queue";
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
  attachmentProblem,
  COMPOSER_MAX_HEIGHT,
  composerResize,
  composerValueWrite,
  commandOf,
  commandParts,
  shellOf,
  insertPick,
  matchCommands,
  slashMenuEnter,
  slashRowSelect,
  MAX_ATTACHMENTS,
  stepAgent,
  promptParts,
  explainSend,
  nextQueued,
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
import { ProviderIcon } from "./provider-icon";
import { hiddenProviders, modelPickerOptions, visibleModels } from "./provider-visibility";
import { modelForComposer, readPreferredModel, writePreferredModel } from "./model-preference";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function sessionModel(v: SessionView | undefined): string | undefined {
  const turns = v?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const assistant = turns[i]?.assistant;
    if (!assistant) continue;
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
  const connected = () => args.caps()?.connected !== false;
  const deliveries = createComposerDelivery();
  onCleanup(deliveries.invalidate);

  const initialSessionId = args.sessionId();
  const sessionQueues = createSessionQueues<Outgoing>(initialSessionId);
  const [draft, setDraft] = createSignal(restoreColdDraft(initialSessionId));
  const [queued, setQueuedSignal] = createSignal<Outgoing[]>(sessionQueues.current());
  const setQueued = (next: Outgoing[] | ((current: Outgoing[]) => Outgoing[])) =>
    setQueuedSignal((current) => {
      const items = typeof next === "function" ? next(current) : next;
      sessionQueues.replace(items);
      return items;
    });
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
  const [detailsOpen, setDetailsOpen] = createSignal(false);
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
  /** Set for the whole IME composition, including the input events inside it. */
  let composing = false;
  /** Character count at the last height decision, so a longer key is not a shrink. */
  let seenChars = 0;
  /** Pixel height of a one-line draft. Backspace below this does not remeasure. */
  let singleLineHeight = 0;

  const citeLine = (note: string) => {
    setDraft((cur) => (cur && !cur.endsWith("\n") ? `${cur}\n${note}` : `${cur}${note}`));
    draftEl?.focus();
  };

  const autogrow = () => {
    const el = draftEl;
    if (!el) return;
    const textShrunk = el.value.length < seenChars;
    seenChars = el.value.length;
    const singleLine =
      singleLineHeight > 0 && !el.value.includes("\n") && el.clientHeight <= singleLineHeight + 1;
    const decision = composerResize({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      textShrunk,
      singleLine,
    });
    if (decision.action === "keep") {
      if (!el.value.includes("\n") && !el.style.height && el.clientHeight > 0) singleLineHeight = el.clientHeight;
      return;
    }
    if (decision.action === "grow") {
      el.style.height = `${decision.height}px`;
      return;
    }
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT);
    el.style.height = `${next}px`;
    if (!el.value.includes("\n")) singleLineHeight = next;
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

  /** The row Enter would use. A menu still catching up to the query falls back to the first match. */
  const commandHighlight = () => {
    const tr = trigger();
    if (tr?.kind !== "command") return undefined;
    const list = menuList();
    if (list.kind === "command" && list.query === tr.query) return menuItems()[menuActive()]?.value;
    return matchCommands(args.commands() ?? [], tr.query)[0]?.name;
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
        setAttachErr(t("composer.attach.too_big", { name: file.name || "file" }));
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

  const allModels = () => args.options()?.models ?? [];
  /**
   * Providers the reader hid from the picker in settings. The current model is
   * still listed below even when its provider is hidden: a session that already
   * names a model must not be silently moved to another one.
   */
  const shownModels = () => visibleModels(allModels());

  createEffect(() => {
    const view = args.view();
    const ready = !!view && view.session_id === args.sessionId() && !args.booting();
    const next = modelForComposer({
      touched: modelTouched(),
      ready,
      inherited: ready ? sessionModel(view) : undefined,
      models: shownModels(),
      remembered: readPreferredModel(),
    });
    if (next !== undefined) setModelSel(next);
  });

  const selectedModel = () =>
    allModels().find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  // empty model means "server default"; still offer that leading model's efforts
  const effortModel = () =>
    selectedModel() ?? shownModels().find((m) => (m.variants?.length ?? 0) > 0);
  const modelOptions = () =>
    modelPickerOptions(allModels(), modelSel(), hiddenProviders(), {
      hidden: t("picker.hiddenProvider"),
      unavailable: t("picker.unavailable"),
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

  const deliver = async (out: Outgoing) => {
    // The session this message was written for. A queued message carries its
    // own; a direct send has none and means the one on screen.
    const target = out.sessionId ?? args.sessionId();
    setSendErr("");
    // A confirmation about the run that just ended says nothing about the one
    // starting, and two of them stacked read as a session stopped twice.
    sessionStop.clearStopped();
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
    // A leading `!` is a shell command, not a prompt and not a slash command.
    // Checked first: `/` and `!` cannot both lead, and reading the draft twice
    // would let a command named like a shell call win on a tie that cannot exist.
    const shell = args.caps()?.shell ? shellOf(out.text) : undefined;
    const command = shell
      ? undefined
      : args.caps()?.commands
        ? commandOf(out.text, (args.commands() ?? []).map((c) => c.name))
        : undefined;
    let revertFailed = false;
    await deliveries.settle({
      sessionId: target,
      out,
      request: async () => {
        if (out.revertTurnId) {
          try {
            await revertSession(target, out.revertTurnId);
          } catch (err) {
            revertFailed = true;
            throw err;
          }
        }
        if (shell) {
          // Deliberately no attachments: the shell endpoint takes a command
          // string, and a file the reader attached would be dropped in silence if
          // this path were chosen with one in hand.
          await runShell(target, shell, choice);
        } else if (command) {
          await runCommand(target, { ...command, parts: commandParts(out.text, out.picked, out.attachments) }, choice);
        } else {
          await sendPrompt(target, promptParts(out.text, out.picked, out.attachments), choice);
        }
      },
      onSuccess: () => {
        // The backend has it now. The handover that mattered — "the reader gave
        // this over and nothing has come back" — is over; what is left is the
        // projection catching up, so the window restarts from here rather than
        // from the press.
        openHandover();
      },
      onFailure: (err) => {
        if (revertFailed && editTurnId() === undefined) setEditTurnId(out.revertTurnId);
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
      },
    });
  };

  const send = () => {
    if (!connected()) {
      setSendErr(t("composer.disconnected"));
      return;
    }
    const revertTurnId = editTurnId();
    if (revertTurnId) setEditTurnId(undefined);
    const out: Outgoing = {
      text: draft().trim(),
      picked: picked(),
      attachments: attachments(),
      // Stamped at the moment of typing, not at the moment of sending. A queued
      // message can outlive the session it was written in, and the queue drains
      // on whatever is open when the run ends.
      sessionId: args.sessionId(),
      ...(revertTurnId ? { revertTurnId } : {}),
    };
    if (!out.text && out.attachments.length === 0) return;
    // A `!` command goes to the shell as a string, so an attachment has nowhere
    // to go. Sending anyway would clear the strip and drop the file without a
    // word — the reader would see it leave and never see it arrive. Refused
    // here, before anything is cleared, so the strip stays put to be removed.
    // Gated on the same capability the send path uses: on a backend without
    // `shell`, a `!` draft is an ordinary prompt, and refusing it for carrying
    // an attachment would block a message that was never going to the shell.
    if (args.caps()?.shell && shellOf(out.text) && out.attachments.length > 0) {
      setAttachErr(t("composer.shell.noAttachments"));
      return;
    }
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
  const canSend = () => connected() && (Boolean(draft().trim()) || attachments().length > 0);

  const runSlash = (name: string, slashArgs: string) => {
    setDraft(slashArgs ? `/${name} ${slashArgs}` : `/${name}`);
    send();
  };

  const chooseRow = (i: number) => {
    const item = menuItems()[i];
    if (trigger()?.kind === "command" && item) {
      const decision = slashRowSelect({ name: item.value, commands: args.commands() ?? [] });
      if (decision.action === "run") {
        runSlash(decision.name, decision.args);
        return;
      }
    }
    pick(i);
  };

  // Enter confirmed an IME composition. A finished slash command runs once the
  // text is committed; an ordinary message waits for a real Enter.
  let imeEnter = false;
  const finishComposition = () => {
    if (!imeEnter) return;
    imeEnter = false;
    const decision = slashMenuEnter({
      draft: draft(),
      highlighted: commandHighlight(),
      commands: args.commands() ?? [],
    });
    if (decision.action === "run") runSlash(decision.name, decision.args);
  };

  // A follow-up typed while the agent is running waits here, then goes out
  // on the next idle. deliver() opens the handover in the same turn, so this
  // does not drain the rest of the queue until that turn finishes.
  createEffect(() => {
    if (args.replayPos() !== null || queuePaused()) return;
    const step = nextQueued(queued(), args.sessionId(), generating());
    if (step.action === "wait") return;
    if (step.action === "drop") {
      // The id changes before resetFor swaps in that session's queue. Keep the
      // foreign entries in their own in-memory queue rather than sending or dropping them.
      return;
    }
    setQueued((q) => q.slice(1));
    void deliver(step.item);
  });

  const editQueued = (index: number) => {
    const item = queued()[index];
    if (!item) return;
    const current: Outgoing = {
      text: draft().trim(),
      picked: picked(),
      attachments: attachments(),
      sessionId: args.sessionId(),
    };
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
    return sessionContext(args.view()?.turns ?? [], model?.context, args.view()?.backend);
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
    <Popover
      open={detailsOpen()}
      onOpenChange={setDetailsOpen}
      gutter={8}
      placement="top-start"
    >
      <Tip
        label={contextLabel(context()?.total ?? 0, context()?.percent ?? null)}
        disabled={detailsOpen()}
      >
        <PopoverTrigger
          class="grid size-8 place-items-center transition-colors hover:bg-secondary"
          aria-label={t("composer.details")}
        >
          <ContextRing percent={context()?.percent ?? null} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent aria-label={t("info.session")}>
        <Show when={args.view()}>
          {(v) => (
            <SessionInfo
              id={args.sessionId()}
              totals={v().totals}
              context={context()}
              model={modelSel()}
              backend={v().backend}
              status={v().status}
              busy={v().busy}
              needsInput={v().pending_permissions.length > 0 || v().pending_questions.length > 0}
              retry={v().retry}
              compacting={v().compacting}
              sessionError={v().session_error}
              workspace={v().workspace}
              branch={args.branch?.()}
            />
          )}
        </Show>
      </PopoverContent>
    </Popover>
  );
  const modelAvailable = () =>
    allModels().length > 0 && (Boolean(modelSel()) || !args.booting());
  const modelSlot = () => (
    <Picker
      showValueInTip
      label={t("picker.model")}
      value={modelSel()}
      options={modelOptions()}
      icon={
        <Show when={splitModel(modelSel())}>
          {(m) => <ProviderIcon provider={m().providerID} />}
        </Show>
      }
      class="composer-model max-w-64"
      onChange={(value) => {
        setModelTouched(true);
        setModelSel(value);
        setVariantSel("");
        writePreferredModel(value);
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
      label={t("picker.agent")}
      capitalize
      value={agentSel()}
      options={(args.options()?.agents ?? []).map((a) => ({ value: a.name, label: a.name }))}
      onChange={setAgentSel}
      class="max-w-24"
    />
  );

  const sessionStop = createSessionStop({
    sessionId: args.sessionId,
    generating,
    request: abortSession,
    refresh: () => void args.refreshView(false),
    beforeRequest: closeHandover,
    setQueuePaused,
    setError: setSendErr,
    unconfirmedError: () => t("stop.unconfirmed"),
    requestError: (err) => explainSend(err instanceof Error ? err.message : "", t("err.abort")),
  });
  createEffect(sessionStop.checkConfirmation);
  const { stop, stopping, stopped } = sessionStop;
  onCleanup(sessionStop.dispose);

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

  // Keyed on the draft alone: on a switch the new id lands before `resetFor`
  // reads the new draft, and writing then would give it the old session's text.
  // The field is not controlled. A keystroke already put the text in the DOM;
  // writing `value` again restarts an IME composition. Only a draft that
  // arrived from outside, and only once composition is over, is copied in.
  createEffect(
    on(
      draft,
      (text) => {
        writeDraft(untrack(args.sessionId), text);
        const el = draftEl;
        if (!el || !composerValueWrite({ composing, domValue: el.value, draft: text })) return;
        el.value = text;
        queueMicrotask(autogrow);
      },
      { defer: true },
    ),
  );

  // A restored draft arrives with a collapsed textarea; grow it once it exists.
  onMount(() => {
    if (draft()) queueMicrotask(autogrow);
  });

  /**
   * Keep every in-memory queue's words on disk. A queue itself is never restored
   * after a restart: only cold initialization takes its text into the draft.
   * Tracking the previous ids also removes storage for queues sent or deleted.
   */
  let persistedQueueSessions = new Set<string>();
  createEffect(() => {
    queued();
    persistedQueueSessions = persistSessionQueues(sessionQueues.snapshot(), persistedQueueSessions);
  });

  /** the session behind the composer changed — swap in its own transient state */
  const resetFor = (id: string) => {
    deliveries.invalidate();
    const restored = deliveries.restore(id, {
      text: readDraft(id),
      picked: [],
      attachments: [],
      sessionId: id,
    });
    setDraft(restored.draft.text);
    setQueuedSignal(sessionQueues.switch(id));
    setHistIndex(-1);
    setHistSaved("");
    setNotice("");
    closeHandover();
    setEcho(undefined);
    sessionStop.reset();
    setModelTouched(false);
    setModelSel("");
    setPicked(restored.draft.picked);
    setAttachments(restored.draft.attachments);
    setAttachErr(restored.dropped ? t("composer.attach.too_many", { n: MAX_ATTACHMENTS }) : "");
    setEditTurnId(undefined);
    setTrigger(undefined);
    queueMicrotask(autogrow);
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    // 229: the key went to the IME, which some webviews report without isComposing.
    // Enter is the exception: a finished slash command has to run on that key
    // even when the webview stamps it 229, as long as composition is over.
    if (e.isComposing || (e.keyCode === 229 && e.key !== "Enter")) {
      if (e.key === "Enter") imeEnter = true;
      return;
    }
    if (menuOpen()) {
      const n = menuItems().length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) setMenuActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && n) {
        e.preventDefault();
        if (trigger()?.kind === "command") {
          const decision = slashMenuEnter({
            draft: draft(),
            highlighted: commandHighlight(),
            commands: args.commands() ?? [],
          });
          if (decision.action === "run") {
            runSlash(decision.name, decision.args);
            return;
          }
          if (decision.action === "insert") {
            const i = menuItems().findIndex((item) => item.value === decision.name);
            pick(i >= 0 ? i : menuActive());
            return;
          }
        }
        pick(menuActive());
        return;
      }
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (n && !e.shiftKey) chooseRow(menuActive());
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

  const onDraftInput: JSX.EventHandler<HTMLTextAreaElement, InputEvent> = (e) => {
    // A composition owns the field until compositionend. An input event that
    // forgets isComposing must not hand the field back early.
    if (e.isComposing) composing = true;
    setDraft(e.currentTarget.value);
    setHistIndex(-1);
    autogrow();
    if (!e.isComposing) track();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    // The box is what the reader sees. A draft written while the IME owned
    // the field stays out of the box; once composition ends, the signal
    // follows the text that was actually committed.
    const el = draftEl;
    if (el && el.value !== draft()) setDraft(el.value);
    track();
    finishComposition();
  };
  const onDraftBlur = () => {
    composing = false;
    setTrigger(undefined);
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
    chooseRow,
    finishComposition,
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
    onDraftInput,
    onCompositionStart,
    onCompositionEnd,
    onDraftBlur,
    bindDraft: (el: HTMLTextAreaElement) => {
      draftEl = el;
      el.value = draft();
      seenChars = el.value.length;
    },
    focusDraft: () => {
      if (!draftEl) return;
      draftEl.focus();
      const end = draftEl.value.length;
      draftEl.setSelectionRange(end, end);
    },
    bindFileInput: (el: HTMLInputElement) => (fileInput = el),
    openFilePicker: () => fileInput?.click(),
    removeAttachment: (id: string) => {
      setAttachErr("");
      setAttachments((l) => l.filter((a) => a.id !== id));
    },
    optionsAgents: () => args.options()?.agents.length ?? 0,
    effortVariants: () => effortModel()?.variants?.length ?? 0,
    decorateTurns: (turns: SessionView["turns"]) => withEcho(turns, echo()),
    /**
     * Whether the queue is holding itself.
     *
     * A stop pauses the queue so the idle it brings does not fire the next
     * follow-up the instant the reader asked it to stop. The pause had no way
     * out that the reader could see or reach: it cleared on the next send, on
     * a failed abort, or on a session switch — none of which is "I stopped, and
     * now I want the rest to go". The items sat there looking queued forever.
     */
    queuePaused,
    resumeQueue: () => setQueuePaused(false),
  };
}

export type SessionComposerCtl = ReturnType<typeof useSessionComposer>;

export function SessionComposer(props: {
  c: SessionComposerCtl;
  sessionId: () => string;
  plan: SessionView["plan"];
  title: string | undefined;
  /**
   * The auto-accept switch, owned by the session above and rendered here.
   *
   * A slot rather than state of its own, because the switch is a property of
   * the session and not of the composer: two panes have two composers and one
   * session each, and a composer that owned the state would show the wrong one
   * the moment a pane took focus.
   */
  permission?: () => JSX.Element;
  /** the session's goal, shown as a strip on top of the composer and edited from the toolbar */
  goal?: string;
  /** The model reported the goal met. The text stays; the loop does not. */
  goalMet?: boolean;
  /** The reader paused the goal. The text stays; idle does not continue it. */
  goalPaused?: boolean;
}) {
  const c = () => props.c;
  const g = useGoal(props.sessionId, () => props.goal, () => props.goalMet, () => props.goalPaused);
  const placeholder = () =>
    paneWorkspace().mode === "multiplex"
      ? c().generating()
        ? t("pane.composer.queue_target", { title: displayTitle(props.title) ?? t("session.untitled") })
        : t("pane.composer.target", { title: displayTitle(props.title) ?? t("session.untitled") })
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
            onPick={c().chooseRow}
            onHover={c().setMenuActive}
          />
        </Show>
        <GoalStrip g={g} />
        <Show when={planVisible(props.plan, c().generating())}>
          <PlanStrip
            sessionId={props.sessionId()}
            plan={props.plan!}
            generating={c().generating()}
            stacked={Boolean(g.shown())}
          />
        </Show>
        <Show when={c().queued().length > 0}>
          <div
            class={`border border-b-0 bg-secondary/70 px-3 pb-4 pt-2 ${
              planVisible(props.plan, c().generating()) || g.shown()
                ? "border-input border-t-input/60"
                : "rounded-t-2xl border-input"
            }`}
          >
            <div class="flex items-center gap-2">
              <p class="min-w-0 flex-1 text-2xs font-medium text-muted-foreground">
                {tn("composer.queued", c().queued().length)}
              </p>
              {/* A stop holds the queue so the idle it brings does not fire the
                  next follow-up immediately. Without saying so, and without a
                  way back, the items sit there looking queued forever. */}
              <Show when={c().queuePaused()}>
                <span class="shrink-0 text-2xs text-muted-foreground">
                  {t("composer.queue.paused")}
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  class="h-auto shrink-0 px-0 py-0 text-xs"
                  onClick={() => c().resumeQueue()}
                >
                  {t("composer.queue.resume")}
                </Button>
              </Show>
            </div>
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
          class={`@container/composer surface-composer rounded-2xl border border-transparent bg-card transition-colors focus-within:border-ring/50 ${c().queued().length > 0 || planVisible(props.plan, c().generating()) || g.shown() ? "-mt-2" : ""}`}
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
            aria-autocomplete="list"
            aria-controls={c().menuOpen() && c().menuItems().length ? c().menuId : undefined}
            aria-activedescendant={
              c().menuOpen() && c().menuItems().length ? `${c().menuId}-${c().menuActive()}` : undefined
            }
            onInput={c().onDraftInput}
            onCompositionStart={c().onCompositionStart}
            onCompositionEnd={c().onCompositionEnd}
            onClick={c().track}
            onBlur={c().onDraftBlur}
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
              // No `accept`: the picker offers every file. Filtering here would
              // have been our guess at what a model can read, and the guess was
              // wrong — OpenCode passes a file part through whatever its type.
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
            permission={props.permission}
            goal={() => <GoalButton g={g} />}
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
