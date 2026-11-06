/**
 * Interpolated scrolling for a discrete mouse wheel over the transcript.
 *
 * WKWebView hands wheel deltas straight to the scroller: one notch is one
 * hard jump, and a virtualized list pays measure-and-paint for each one, so
 * wheel scrolling reads as a series of steps where trackpad panning — which
 * the OS eases — reads as smooth. This takes the notches over: each wheel
 * event adds to a target and a frame loop walks the scroller toward it on an
 * exponential ease, close to how the trackpad path already feels.
 *
 * It stays out of the way everywhere else. Trackpad deltas (small, continuous)
 * fall under the chunk threshold and scroll natively; pinch-zoom, shift-wheel
 * and horizontal intent pass through untouched; line- and page-mode deltas
 * scale natively; reduced motion disables the whole thing. A scrollbar drag, a
 * touch, or any other writer that moves the scroller is detected as a position
 * we did not write and cancels the animation. The scroll owner is the one
 * exception: while a notch is easing it stands aside, so its layout corrections
 * do not read as a foreign scroll and take the gesture's remaining distance
 * with them. It takes the position back from onScroll as the ease moves.
 *
 * The listener has to be non-passive: easing a notch means calling
 * preventDefault, and the browser cannot know whether this event will be one
 * until the handler runs. That is the price of the effect; a trackpad pan still
 * scrolls natively, but its event queues behind this one.
 */
export const WHEEL_CHUNK_PX = 32;
/**
 * A large delta this soon after another wheel event is a trackpad still
 * accelerating, not a new notch. WebKit exposes no phase or momentumPhase to
 * JS, and a fast flick's first delta can still look like a notch; once the
 * stream turns small, the next event takes the gesture back.
 */
export const WHEEL_STREAM_MS = 100;
export const SMOOTH_TAU_MS = 100;
export const SMOOTH_EPSILON_PX = 0.5;

/**
 * Whether this event reads as a discrete wheel notch worth easing. Trackpad
 * pans produce many small deltas per gesture; a notch produces one event well
 * over the chunk size, which is the only signal WebKit gives us to tell them
 * apart.
 */
export function isSmoothingCandidate(e: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (e.ctrlKey || e.shiftKey) return false;
  // Lines and pages: the browser scales these itself; easing pixels we guessed
  // from them would change how far a notch travels.
  if (e.deltaMode !== 0) return false;
  return Math.abs(e.deltaY) > Math.abs(e.deltaX) && Math.abs(e.deltaY) >= WHEEL_CHUNK_PX;
}

/** A new notch adds to the target still being approached, so a fast wheel
    spins the same total distance native scrolling would, only eased. */
export function nextTarget(current: number, pending: number | null, deltaY: number, max: number): number {
  return Math.min(max, Math.max(0, (pending ?? current) + deltaY));
}

/** Exponential approach, frame-rate independent: two half-length steps land
    where one full step would. Snaps the last epsilon so the loop terminates
    instead of asymptoting forever. */
export function approach(current: number, target: number, dtMs: number, tau = SMOOTH_TAU_MS): number {
  const next = target + (current - target) * Math.exp(-dtMs / tau);
  return Math.abs(target - next) < SMOOTH_EPSILON_PX ? target : next;
}

export interface WheelSmoother {
  /** True while a notch's distance is still being spent. */
  active: () => boolean;
  /** Stop easing and drop whatever distance is left. */
  cancel: () => void;
  dispose: () => void;
}

export function createWheelSmoother(el: HTMLElement): WheelSmoother {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let target: number | null = null;
  let written = 0;
  let prev = 0;
  let frame = 0;
  let lastWheelAt = -Infinity;

  const running = () => frame !== 0;
  const limit = () => Math.max(0, el.scrollHeight - el.clientHeight);
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    target = null;
  };

  const tick = (now: number) => {
    if (target === null) {
      frame = 0;
      return;
    }
    // A background tab freezes rAF; on return the gap would fling the scroll
    // the whole remaining distance in one frame, so clamp the step.
    const dt = Math.min(64, now - prev);
    prev = now;
    const next = approach(el.scrollTop, target, dt);
    el.scrollTop = next;
    // Reading back is the position the scroller actually took (it may be
    // quantized to device pixels); comparing against it is what tells the
    // handler below "this one was mine".
    written = el.scrollTop;
    if (next === target) {
      cancel();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (running()) return;
    prev = performance.now();
    frame = requestAnimationFrame(tick);
  };

  const onWheel = (e: WheelEvent) => {
    const now = performance.now();
    const since = now - lastWheelAt;
    lastWheelAt = now;
    if (reduced.matches || !isSmoothingCandidate(e)) {
      // A small delta behind a notch means this is a trackpad after all (or a
      // pinch/shift/horizontal gesture): hand the rest of the gesture back.
      if (target !== null) cancel();
      return;
    }
    const at = el.scrollTop;
    const max = limit();
    // Nowhere to go: hand the event to the native handler rather than eating
    // a notch the reader aimed past the edge.
    if ((e.deltaY < 0 && at <= 0) || (e.deltaY > 0 && at >= max)) return;
    // A big delta right behind another wheel event is a trackpad accelerating,
    // not a fresh notch. Let the platform own that gesture.
    if (target === null && since < WHEEL_STREAM_MS) return;
    e.preventDefault();
    target = nextTarget(at, target, e.deltaY, max);
    // A fresh gesture starts from where the scroller is; otherwise the first
    // tick's scroll event would compare against a position from before it.
    if (!running()) written = at;
    start();
  };
  const onScroll = () => {
    if (target !== null && Math.abs(el.scrollTop - written) > 1) cancel();
  };
  const onPointerDown = () => cancel();
  const onReduced = () => {
    if (reduced.matches) cancel();
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  reduced.addEventListener("change", onReduced);
  return {
    active: () => target !== null,
    cancel,
    dispose: () => {
      cancel();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", onPointerDown);
      reduced.removeEventListener("change", onReduced);
    },
  };
}
