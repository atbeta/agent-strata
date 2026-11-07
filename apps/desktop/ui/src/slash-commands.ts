import { createMemo, type Resource } from "solid-js";
import {
  abortSession,
  backendLabel,
  downloadExport,
  forkSession,
  handoffSession,
  renameSession,
  revertSession,
  shareSession,
  summarizeSession,
  unrevertSession,
  unshareSession,
  type CommandInfo,
  type Connection,
  type SessionCapabilities,
  type SessionView,
} from "./api";
import { builtinCommands, handoffTargets, resolveHandoff } from "./composer-input";
import { copyText } from "./clipboard";
import { messageText } from "./transcript-format";
import { settled } from "./resource";
import { t } from "./i18n";
import type { useSessionComposer } from "./session-composer";

const BUILTIN_DESC: Record<string, () => string> = {
  compact: () => t("cmd.compact"),
  summarize: () => t("cmd.compact"),
  undo: () => t("cmd.undo"),
  redo: () => t("cmd.redo"),
  interrupt: () => t("cmd.interrupt"),
  fork: () => t("cmd.fork"),
  rename: () => t("cmd.rename"),
  share: () => t("cmd.share"),
  unshare: () => t("cmd.unshare"),
  export: () => t("cmd.export"),
  new: () => t("cmd.new"),
  terminal: () => t("cmd.terminal"),
};

/**
 * Commands the slash menu shows on top of the backend's own: the session
 * actions a CLI keyboard user expects (`/compact`, `/undo`, …), which the
 * backend never lists because they are client actions over plain endpoints,
 * not prompt templates. `commands()` still reports the backend list on its
 * own for anything that wants it unmerged.
 */
export function useSlashCommands(
  props: { id: string; connections?: Connection[]; onNewSession: () => void },
  deps: {
    view: Resource<SessionView | undefined>;
    caps: Resource<SessionCapabilities | undefined>;
    commands: () => CommandInfo[] | undefined;
    opencode: () => boolean;
    /** Created after this hook, which it feeds; read only when a command runs. */
    composer: () => ReturnType<typeof useSessionComposer>;
    toggleTerminal: () => void;
  },
) {
  const { view, caps } = deps;
  const targets = createMemo(() => {
    // Wait for capabilities before marking the current backend, so the single
    // target's description does not change after the reader opens the menu.
    if (caps.state === "unresolved" || caps.state === "pending") return [];
    return handoffTargets(
      (props.connections ?? []).map((connection) => ({
        id: connection.id,
        label: connection.name?.trim() || backendLabel(connection.backend),
        detail: connection.baseUrl,
        prompt: connection.capabilities?.prompt === true,
      })),
      caps()?.connection_id,
    );
  });
  const slashCommands = createMemo((): CommandInfo[] | undefined => {
    const c = caps();
    // A stored session whose backend is gone can still be handed off. The
    // slash menu used to wait until a backend was driving this session, which
    // hid the one command that exists for that case.
    const receiving = targets();
    if (!c?.connected && receiving.length === 0) return undefined;
    const v = settled(view);
    const local = builtinCommands({
      summarize: c?.summarize,
      revert: c?.revert,
      reverted: Boolean(v?.revert_turn_id),
      abort: c?.abort,
      fork: c?.fork,
      handoff: receiving.length > 0,
      hasTurns: (v?.turns.length ?? 0) > 0,
      manage: c?.manage,
      share: c?.share,
      terminal: deps.opencode(),
    }).map((name): CommandInfo => ({
      name,
      source: "builtin",
      description:
        name === "handoff"
          ? receiving.length === 1
            ? receiving[0]!.current
              ? t("cmd.handoff.current")
              : t("cmd.handoff.one", { name: receiving[0]!.label })
            : t("cmd.handoff.many", { names: receiving.map((target) => target.label).join(", ") })
          : BUILTIN_DESC[name]?.(),
      argument: name === "handoff" && receiving.length !== 1,
    }));
    return [...local, ...(c?.connected ? (deps.commands() ?? []) : [])];
  });

  const runBuiltin = async (name: string, arg: string): Promise<void> => {
    const composer = deps.composer();
    switch (name) {
      case "compact":
      case "summarize": {
        const sel = composer.modelSel();
        const slash = sel.indexOf("/");
        const model = slash > 0 ? { providerID: sel.slice(0, slash), modelID: sel.slice(slash + 1) } : undefined;
        await summarizeSession(props.id, model);
        return;
      }
      case "undo": {
        // The CLI's undo: stop a run in flight first so the revert lands on a
        // settled session, then hand the text back to the composer rather than
        // resending it — editing before resend is the whole point.
        const last = [...(settled(view)?.turns ?? [])]
          .reverse()
          .find((turn) => !turn.reverted && turn.user && messageText(turn.user).trim() !== "");
        if (!last) throw new Error(t("cmd.undo.none"));
        if (composer.generating()) await abortSession(props.id);
        await revertSession(props.id, last.turn_id);
        composer.setDraft(messageText(last.user ?? []));
        queueMicrotask(() => composer.autogrow());
        return;
      }
      case "redo":
        await unrevertSession(props.id);
        return;
      case "interrupt":
        await composer.stop();
        return;
      case "handoff": {
        const list = targets();
        const target = resolveHandoff(list, arg);
        if (!target) {
          throw new Error(
            list.length === 0
              ? t("cmd.handoff.none")
              : t("cmd.handoff.missing", { names: list.map((item) => item.label).join(", ") }),
          );
        }
        const id = await handoffSession(props.id, target.id, composer.choice());
        location.hash = `/session/${encodeURIComponent(id)}`;
        return;
      }
      case "fork": {
        if (!settled(view)?.turns.length) throw new Error(t("cmd.fork.none"));
        const id = await forkSession(props.id, "all");
        location.hash = `/session/${encodeURIComponent(id)}`;
        return;
      }
      case "rename": {
        const title = arg.trim();
        if (!title) throw new Error(t("cmd.rename.missing"));
        await renameSession(props.id, title);
        return;
      }
      case "share": {
        const url = await shareSession(props.id);
        composer.setNotice(url && (await copyText(url)) ? t("cmd.share.copied") : url || t("cmd.share.done"));
        return;
      }
      case "unshare":
        await unshareSession(props.id);
        composer.setNotice(t("cmd.share.removed"));
        return;
      case "export":
        await downloadExport(props.id);
        return;
      case "terminal":
        deps.toggleTerminal();
        return;
      case "new":
        props.onNewSession();
        return;
    }
  };

  return { slashCommands, runBuiltin };
}
