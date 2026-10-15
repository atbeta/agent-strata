import { For } from "solid-js";
import { SessionDetail, panelOpen } from "./session-detail";

/**
 * One row of sessions. Columns share the width and scroll sideways once a
 * column would drop under a readable minimum. The hairline between them is
 * the same border the sidebar uses; a layout library would bring its own
 * chrome, and this row does not need nested splits.
 */
export function SessionBoard(props: {
  ids: readonly string[];
  activeId: string;
  sessions: {
    summary: { session_id: string };
    title?: string;
    parent?: string;
    status: string;
    busy?: boolean;
    needs_input?: boolean;
  }[];
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const several = () => props.ids.length > 1;
  return (
    <div class="flex h-full min-h-0 snap-x snap-mandatory overflow-x-auto overflow-y-hidden">
      <For each={props.ids}>
        {(id) => {
          const active = () => id === props.activeId;
          // Equal columns while watching. The files panel belongs to the
          // focused session, and only then does that column ask for room.
          const min = () => (several() ? (active() && panelOpen() ? "min-w-[40rem]" : "min-w-[22.5rem]") : "min-w-0");
          return (
            <section
              class={`flex h-full min-h-0 flex-1 basis-0 snap-start flex-col border-l border-border first:border-l-0 ${min()}`}
              aria-current={active() ? "true" : undefined}
              onPointerDown={() => {
                if (!active()) props.onFocus(id);
              }}
            >
              <SessionDetail
                id={id}
                sessions={props.sessions}
                active={active()}
                closable={several()}
                onClose={() => props.onClose(id)}
              />
            </section>
          );
        }}
      </For>
    </div>
  );
}
