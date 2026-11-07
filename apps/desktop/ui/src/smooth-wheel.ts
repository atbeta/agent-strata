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
 * The step a first frame is given.
 *
 * The loop is started from the wheel handler, whose clock reads `performance.now()`
 * — but a frame callback is stamped with the frame's start, which can be before
 * that. The difference is then zero or negative, and `exp(0)` is exactly 1, so
 * the ease returns the position it just read and the gap never closes. Rather
 * than floor that to a millisecond (a step of half a pixel, which the scroller
 * rounds away), the first frame simply gets a nominal frame's worth.
 */
export const NOMINAL_FRAME_MS = 16;
/**
 * A frame that moved the scroller less than this made no progress.
 *
 * The scroller quantizes what it is given: ask for 800598.6 and it stores
 * 800599, so a write can land where the position already was. Reading back is
 * the only way to know, and "it did not land" is a state the loop has to
 * recognise — see `stalled`.
 */
export const STALL_EPSILON_PX = 0.01;

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

/**
 * The time step for this frame.
 *
 * The first frame has no usable delta — `prev` is still the sentinel — so it
 * gets a nominal one. After that, a background tab freezes rAF and the gap
 * would fling the scroll the whole remaining distance in one frame, so the step
 * is capped.
 */
export function frameDelta(now: number, prev: number): number {
  if (prev <= 0) return NOMINAL_FRAME_MS;
  return Math.min(64, Math.max(1, now - prev));
}

/**
 * Whether this frame left the position where it was.
 *
 * `approach` returns the position it was given when `dt` is zero, and the
 * scroller rounds what it stores: both leave `after === before`. A single such
 * frame is not a stall — the first frame of a notch moves half a pixel and is
 * rounded away, and the next frame moves eight. Only a run of them is, which is
 * what `STALL_FRAMES` is for.
 */
export function stalled(before: number, after: number, target: number): boolean {
  if (Math.abs(target - after) <= SMOOTH_EPSILON_PX) return false;
  return Math.abs(after - before) < STALL_EPSILON_PX;
}

/**
 * How many frames in a row may leave the position where it was before the loop
 * gives up.
 *
 * One frame of rounding is normal. A scroller that has stopped accepting the
 * write produces them forever — near the target the remaining distance can be
 * smaller than the rounding step, so the ease computes a position that the
 * scroller rounds back onto the one it just had, and the gap never closes. Three
 * frames is past any rounding, and short enough that a stuck loop cannot be felt.
 */
export const STALL_FRAMES = 3;

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
  /** Consecutive frames that left the position unchanged. See STALL_FRAMES. */
  let idle = 0;
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
    // the whole remaining distance in one frame, so clamp the step. The lower
    // bound matters as much — see `frameDelta` for what a zero dt does.
    const dt = frameDelta(now, prev);
    prev = now;
    // The target was taken against the extent at the wheel event. Rows are
    // measured while the ease runs, so the column may have shrunk under it;
    // chasing a position past the new limit is a gap that never closes.
    const max = limit();
    if (target > max) target = max;
    else if (target < 0) target = 0;
    const from = el.scrollTop;
    const next = approach(from, target, dt);
    el.scrollTop = next;
    // Reading back is the position the scroller actually took (it may be
    // quantized to device pixels); comparing against it is what tells the
    // handler below "this one was mine".
    written = el.scrollTop;
    if (next === target) {
      cancel();
      return;
    }
    // The write did not land and the target is still out of reach. A single
    // frame of that is the scroller rounding half a pixel away; a run of them
    // is a written position it will never take, and another frame would compute
    // the same number again forever — stop, and give the position back to the
    // owner.
    if (stalled(from, written, target)) {
      idle += 1;
      if (idle >= STALL_FRAMES) {
        cancel();
        return;
      }
    } else {
      idle = 0;
    }
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (running()) return;
    idle = 0;
    // No clock read here: the frame callback carries its own timestamp, and
    // `performance.now()` at this moment is later than it. `frameDelta` gives
    // the first frame a nominal step instead.
    prev = 0;
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
