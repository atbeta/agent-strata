import { createEffect, createSignal } from "solid-js";
import type { SessionRow } from "./api";
import { readMru, recentOrder, stepIndex, touchMru, writeMru } from "./session-switch";
import { t } from "./i18n";

/**
 * The ⌃⇥ / ⌘⇥-style session switcher: MRU ordering, the chord-held overlay,
 * and commit-on-release. `chordHeld` is set by the app's key handler while a
 * command chord runs, so a bare step navigates immediately while a held chord
 * opens the overlay instead.
 */
export function useSessionSwitcher(opts: {
  sessions: () => SessionRow[];
  activeId: () => string | undefined;
  /** Whether an id names a real session — the MRU list ignores ghosts. */
  exists: (id: string) => boolean;
  chordHeld: () => boolean;
}) {
  const [switchOpen, setSwitchOpen] = createSignal(false);
  const [switchIds, setSwitchIds] = createSignal<string[]>([]);
  const [switchAt, setSwitchAt] = createSignal(0);
  let seenSession: string | undefined;

  const switchSource = () =>
    opts.sessions().map((s) => ({
      id: s.summary.session_id,
      title: s.title || s.summary.title || t("common.untitled"),
      lastTs: Date.parse(s.summary.last_ts) || 0,
    }));

  const moveSession = (delta: number) => {
    const opening = !switchOpen();
    const ids = opening ? recentOrder(switchSource(), readMru(), opts.activeId()) : switchIds();
    const at = stepIndex({
      length: ids.length,
      at: opening ? null : switchAt(),
      delta,
      currentAtFront: ids[0] === opts.activeId(),
    });
    if (at === null) return;
    if (!opts.chordHeld()) {
      const id = ids[at];
      if (id) location.hash = `/session/${encodeURIComponent(id)}`;
      return;
    }
    if (opening) setSwitchIds(ids);
    setSwitchAt(at);
    setSwitchOpen(true);
  };

  const commitSwitch = () => {
    if (!switchOpen()) return;
    const id = switchIds()[switchAt()];
    setSwitchOpen(false);
    if (id && id !== opts.activeId()) location.hash = `/session/${encodeURIComponent(id)}`;
  };

  const chooseSwitch = (id: string) => {
    setSwitchOpen(false);
    if (id !== opts.activeId()) location.hash = `/session/${encodeURIComponent(id)}`;
  };

  createEffect(() => {
    const id = opts.activeId();
    if (seenSession !== undefined && id !== seenSession) setSwitchOpen(false);
    seenSession = id;
  });

  // The overlay's order is the MRU list, so the list must learn about the
  // session the reader is sitting in — but only sessions that still exist.
  createEffect(() => {
    const id = opts.activeId();
    if (!id || !opts.exists(id)) return;
    const prev = readMru();
    if (prev[0] === id) return;
    writeMru(touchMru(prev, id));
  });

  return {
    switchOpen,
    setSwitchOpen,
    switchIds,
    switchAt,
    switchSource,
    moveSession,
    commitSwitch,
    chooseSwitch,
  };
}
