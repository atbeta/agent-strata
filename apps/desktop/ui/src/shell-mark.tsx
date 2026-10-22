import { Tip } from "./tip";
import { t } from "./i18n";

/** The command a session's shell is still waiting on. Quiet, and only as wide as the row can spare. */
export function ShellMark(props: { command: string; detail: string }) {
  return (
    <Tip label={t("session.shell.running", { command: props.detail })}>
      <span class="max-w-20 shrink-0 truncate font-mono text-2xs text-status-active">{props.command}</span>
    </Tip>
  );
}
