// The instruction half of the dev plugin.
//
// A tool description says what a tool does; it does not stop a model doing
// what it already does. The habit here is `Start-Process`, and a habit loses
// only to an instruction that names it. Parameter tutorials (port, workdir,
// `$`, offset, restart) stay on the tool descriptions. This text is only the
// cross-tool choice, that habit, and how to read a failure. It is contributed
// through `hooks.systemPrompt`; the shim only concatenates.

/** What the model is told before it reads the request. */
export const GUIDANCE = `
## Choose the execution tool

Use the regular shell for a one-shot, non-interactive command.

Use \`dev_start\` for a long-running, non-interactive command such as a development
server or watcher. Use \`dev_logs\` with its process_id, \`dev_restart\` to run it
again under the same id, and \`dev_stop\` to stop it.

Use \`terminal_create\` only when the program needs a TTY or interactive stdin, such
as a REPL, SSH, or an interactive prompt. Use \`terminal_read\` with its terminal_id,
\`terminal_write\` to send input, and \`terminal_close\` to close it. A terminal's
output_idle only means no PTY output arrived during that quiet window; it does not
mean the command finished.

Do not use \`dev_logs\` for a terminal_id or \`terminal_read\` for a process_id.

Do not use \`Start-Process\` (PowerShell), \`&\` (bash), \`nohup\`, or \`start /b\`.
A detached process never reaches the transcript and keeps its port after the
app closes. If \`dev_start\` reports that the shell is not running, say so and
ask — do not fall back to \`Start-Process\`.

A port that is already served is refused, with the reason. Stop what holds it
first; starting a second command on the same port only produces a failure that
looks like it belongs to the new command.

A row marked lost says whether the process is still the one that was started
and whether its port is still held. Read that sentence.
`;

/**
 * The tool ids a shell runs under, which is what a hook has to name.
 *
 * `shell` is not one of them: OpenCode registers `bash` everywhere and
 * `powershell` on Windows, and `tool.execute.before` reports the registered
 * id. The old plugin declared `["shell"]` and checked `tool !== "shell"`, so
 * the Start-Process guard — the Windows case it exists for — never ran. The
 * other names are here because other backends do use them, and a guard that
 * silently does not apply is worse than no guard.
 */
export const SHELL_TOOL_IDS = ["bash", "powershell", "shell", "execute", "terminal"] as const;

/** Whether a command is an attempt to detach a process. */
export function detaches(command: string): boolean {
  return /\bStart-Process\b/i.test(command) || /\bnohup\b/i.test(command) || /\bstart\s+\/b\b/i.test(command);
}
