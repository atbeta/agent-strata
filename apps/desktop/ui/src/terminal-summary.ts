import { t } from "./i18n";

/** What one running terminal contributes to the capsule's hover label. */
export interface TerminalFact {
  title: string;
  command: string;
  cwd: string;
  mode: "user" | "shared";
}

/**
 * One line a reader can scan without opening the tab.
 *
 * The title is which terminal. The mode says whether the agent can type in
 * it. A command is included only when it is not the shell itself and not
 * already the title. The directory is the folder name, which is the part
 * that distinguishes two shells in two projects.
 */
export function terminalDetail(row: TerminalFact): string {
  const mode = t(row.mode === "shared" ? "terminal.pill.shared" : "terminal.pill.user");
  const command = runningCommand(row.command);
  const where = folderName(row.cwd);
  const name = row.title.trim() || command || where;
  return [name, mode, command && command !== name ? command : "", where && where !== name ? where : ""]
    .filter(Boolean)
    .join(" · ");
}

/** A bare shell path is the terminal, not work happening inside it. */
function runningCommand(command: string): string {
  const text = command.trim();
  if (!text) return "";
  const base = text.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (["zsh", "bash", "fish", "sh", "pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe"].includes(base)) {
    return "";
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function folderName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return "";
  return trimmed.split(/[/\\]/).pop() ?? trimmed;
}
