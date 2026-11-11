import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

export type WindowsShell = { path: string; name: "pwsh" | "powershell" | "cmd" };

/**
 * Pick a shell from what was found on the machine.
 *
 * Pure, and separate from the lookup, because the ordering is the whole point:
 * `pwsh` first, `powershell` next, `cmd` only when neither exists. A model
 * writes PowerShell, and handing that to cmd fails in a way that reads like the
 * command was wrong.
 */
export function chooseWindowsShell(found: {
  pwsh?: string | null;
  powershell?: string | null;
  comspec?: string | null;
}): WindowsShell {
  if (found.pwsh) return { path: found.pwsh, name: "pwsh" };
  if (found.powershell) return { path: found.powershell, name: "powershell" };
  return { path: found.comspec || "cmd.exe", name: "cmd" };
}

export function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  // A dev server that inherits the service's own PORT would collide with it.
  delete out.STRATA_PORT;
  delete out.STRATA_API_TOKEN;
  delete out.STRATA_OPENCODE_URL;
  delete out.STRATA_OPENCODE_USERNAME;
  delete out.STRATA_OPENCODE_PASSWORD;
  // Coloured output is unreadable in a log pane that has no terminal.
  out.FORCE_COLOR = "0";
  out.NO_COLOR = "1";
  return out;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The file a command names, for the "did you mean the script next to it" case. */
export function commandName(command: string): string {
  const text = command.trim();
  // A quoted first token is a path with spaces in it, and the quotes are the
  // only thing that says where it ends. Splitting on whitespace first would
  // return the middle of the path instead of the binary.
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]!;
    const end = text.indexOf(quote, 1);
    const quoted = end > 0 ? text.slice(1, end) : text.slice(1);
    return basename(quoted);
  }
  const first = text.split(/\s+/)[0] ?? "";
  return basename(first);
}

/** A command that is plausibly meant to stay up, and so belongs here. */
export function looksLongRunning(command: string): boolean {
  const text = command.toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(text)) return true;
  if (/\b(vite|next\s+dev|nuxt\s+dev|nodemon|webpack\s+serve)\b/.test(text)) return true;
  // `./gradlew` starts with a path separator, so the leading word boundary
  // before `gradlew` never matches. Name the wrapper without one.
  if (/(^|[\s;&|])(\.\/)?(mvn|gradlew|gradle)(\s|$)/.test(text) && /\b(spring-boot:run|bootrun|run)\b/.test(text))
    return true;
  if (/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver)\b/.test(text)) return true;
  if (/\b(dotnet\s+(run|watch))\b/.test(text)) return true;
  if (/\b(cargo\s+(run|watch))\b/.test(text)) return true;
  if (/\bgo\s+run\b/.test(text)) return true;
  if (/\b(rails\s+server|php\s+artisan\s+serve)\b/.test(text)) return true;
  return false;
}

/** A path that exists, so a caller can tell "wrong directory" from "wrong command". */
export function existingDirectory(path: string): boolean {
  return existsSync(path) && isDirectory(path);
}
