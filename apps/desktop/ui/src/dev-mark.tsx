/**
 * The mark for a background command that is running.
 *
 * Deliberately not the session busy grid. That one says "this conversation is
 * thinking": a 4×4 cluster breathing on its own phases, which belongs to the
 * session row and to the fleet. A background command is a different fact — a
 * process is alive in a terminal — and reusing the same breathing mark made the
 * composer pill read as "the session is busy" a second time.
 *
 * A terminal chevron with a hard-blinking caret is the shape that says
 * "something is running in a shell", and a step blink reads as a cursor rather
 * than as a pulse. Reduced motion keeps the caret solid.
 */
export function DevRunningMark(props: { class?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      class={`dev-running shrink-0 ${props.class ?? "size-3.5"}`}
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.2 4.4 6.6 8l-3.4 3.6" />
      <rect
        x="8.6"
        y="9.6"
        width="4.4"
        height="2.2"
        rx="0.6"
        fill="currentColor"
        stroke="none"
        class="dev-running-caret"
      />
    </svg>
  );
}
