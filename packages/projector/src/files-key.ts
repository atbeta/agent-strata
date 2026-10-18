import type { SessionView } from "./index";

/** File changes only ever add records, so the record count names a files list. */
export function filesKeyOf(view: Pick<SessionView, "files_changed">): string {
  return `${view.files_changed.length}:${view.files_changed.reduce((n, f) => n + f.count, 0)}`;
}
