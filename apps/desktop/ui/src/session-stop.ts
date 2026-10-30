import { createSignal } from "solid-js";
import { createRequestOwner, type RequestToken } from "./request-owner";
import { stopConfirmed } from "./stop-verdict";

export const STOP_TIMEOUT_MS = 8_000;

type StopTimer = ReturnType<typeof setTimeout> | number;

export function createSessionStop(deps: {
  sessionId: () => string;
  generating: () => boolean;
  request: (sessionId: string) => Promise<void>;
  refresh: () => void;
  beforeRequest: () => void;
  setQueuePaused: (paused: boolean) => void;
  setError: (message: string) => void;
  unconfirmedError: () => string;
  requestError: (error: unknown) => string;
  timeoutMs?: number;
  schedule?: (callback: () => void, ms: number) => StopTimer;
  cancel?: (timer: StopTimer) => void;
}) {
  const owner = createRequestOwner();
  const [attempt, setAttempt] = createSignal<RequestToken>();
  const [accepted, setAccepted] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const schedule = deps.schedule ?? setTimeout;
  const cancel = deps.cancel ?? clearTimeout;
  let watchdog: StopTimer | undefined;

  const clearWatchdog = () => {
    if (watchdog !== undefined) cancel(watchdog);
    watchdog = undefined;
  };

  const invalidate = () => {
    owner.invalidate();
    clearWatchdog();
    setAttempt(undefined);
    setAccepted(false);
  };

  const fail = (token: RequestToken, message: () => string) => {
    if (!owner.isCurrent(token)) return;
    invalidate();
    setStopped(false);
    deps.setQueuePaused(false);
    deps.setError(message());
  };

  const checkConfirmation = () => {
    const token = attempt();
    if (!token || !stopConfirmed(accepted(), deps.generating())) return;
    if (!owner.isCurrent(token)) return;
    invalidate();
    setStopped(true);
  };

  const stop = async () => {
    if (attempt()) return;
    deps.setError("");
    setStopped(false);
    const token = owner.begin(deps.sessionId());
    setAttempt(token);
    setAccepted(false);
    clearWatchdog();
    watchdog = schedule(() => fail(token, deps.unconfirmedError), deps.timeoutMs ?? STOP_TIMEOUT_MS);
    deps.beforeRequest();
    deps.setQueuePaused(true);
    try {
      await deps.request(token.sessionId);
      if (!owner.isCurrent(token)) return;
      setAccepted(true);
      deps.refresh();
      checkConfirmation();
    } catch (error) {
      fail(token, () => deps.requestError(error));
    }
  };

  return {
    stop,
    stopping: () => attempt() !== undefined,
    stopped,
    checkConfirmation,
    clearStopped: () => setStopped(false),
    reset() {
      invalidate();
      setStopped(false);
      deps.setQueuePaused(false);
      deps.setError("");
    },
    dispose: invalidate,
  };
}
