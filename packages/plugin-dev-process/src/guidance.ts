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

Use the regular shell for one-shot, non-interactive commands.

Use \`dev_start\` for long-running, non-interactive servers and watchers. Use
\`dev_logs\` with its process_id, \`dev_restart\` for the same id, and \`dev_stop\`.

Use \`terminal_create\` only for TTY or interactive stdin (REPL, SSH, prompts). Use
\`terminal_write\` for input and new output, \`terminal_read\` with its terminal_id and
next_offset for later output, and \`terminal_close\`. For shell input, use submit:true instead of
a trailing newline. Read only with the newest next_offset; write already returns its new output.
output_idle and a wait_reason of output_idle mean no PTY output in that quiet window; neither
means the command finished. Only shared terminals are visible to you; both sides may write.

For an exit code, append \`echo EXIT=$?\` (or the shell equivalent). Prefer batch
output for machines (\`top -b -n1\`, \`docker ps\`, \`jq\`, \`grep\`). terminal_read is
linear text, not a screen snapshot; do not read a full-screen TUI with it. Separate
sections with \`=== STATUS ===\`, not clear. For slow SSH, wait_ms may be up to 30000.

Ask the user to enter real or production passwords, one-time codes, and recovery codes.
Development or test credentials explicitly supplied for the task may be entered when needed.

Never use \`dev_logs\` for a terminal_id or \`terminal_read\` for a process_id.

Do not use \`Start-Process\`, \`&\`, \`nohup\`, or \`start /b\`: detached processes lose
their output and keep their port. If \`dev_start\` says the shell is not running, ask;
do not fall back to \`Start-Process\`.

A port already served is refused; stop its holder first. A row marked lost says
whether the process and its port are still present.
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
