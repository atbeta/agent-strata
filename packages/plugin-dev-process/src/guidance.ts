// The instruction half of the dev plugin.
//
// A tool description says what a tool does; it does not stop a model doing
// what it already does. The habit here is `Start-Process`, and a habit loses
// only to an instruction that names it. This text is contributed through
// `hooks.systemPrompt`, so it arrives through the same route as any other
// plugin's; the shim only concatenates.

/** What the model is told before it reads the request. */
export const GUIDANCE = `
## Long-running commands

A development server, a watcher, or anything else meant to keep running must be
started with the \`dev_start\` tool.

Do not use \`Start-Process\` (PowerShell), \`&\` (bash), \`nohup\`, \`start /b\`, or a
background job to start one. Hiding the window does not make the process owned:
its output never reaches the transcript, it holds its port after the app closes,
and stopping it means finding its pid by hand.

Pass \`port\` when you know it — \`dev_start\` then returns once the port answers,
so there is no need to sleep and guess.

Pass \`workdir\` when the command belongs in a subdirectory of the session
workspace. Do not \`cd\`, \`Set-Location\`, or \`pushd\` inside the command. The
working directory is \`workdir\`, and a command that changes directory itself
fails when the shell is not already there.

A \`$\` in the command is expanded by the outer shell before \`dev_start\` sees
it. \`$true\` becomes \`True\`, and PowerShell then says \`True\` is not a
command. Escape a dollar that must survive — a backtick in PowerShell, a
backslash in bash — or avoid it (\`while(1)\` rather than \`while($true)\`).
\`$!\` and \`$?\` need the same treatment.

A port that is already served is refused, with the reason. Stop what holds it
first; starting a second command on the same port only produces a failure that
looks like it belongs to the new command.

\`dev_logs\` takes \`offset\`. Pass the \`next_offset\` from the previous read so
only new lines come back. Do not re-read the whole log.

A row marked lost says whether the process is still the one that was started
and whether its port is still held. Read that sentence.

Use \`dev_restart\` to run the same command again under the same id. Do not
\`dev_stop\` and then \`dev_start\`: that mints a new id and throws away the one
already written down.

If \`dev_start\` reports that the shell is not running, say so and ask — do not
fall back to \`Start-Process\`.
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
