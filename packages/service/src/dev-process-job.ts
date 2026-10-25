// Windows: one job object per command.
//
// A dev server is a shell that runs a script that runs a runtime, and the
// runtime is what holds the port. Killing the shell leaves the runtime
// running. On Windows there is no process group to signal — `kill` is
// TerminateProcess, one pid at a time — and `taskkill /T` walks the parent
// links, so a middle process that exits first orphans everything under it.
// What is left is a tree that keeps running while the record says stopped,
// which is the worst of both: the port is still held and the next start
// collides with it.
//
// A job object is the one structure Windows offers for exactly this. The
// child is created suspended, put in the job, and resumed; the job is marked
// to die when its last handle closes. The supervisor holds that handle, so
// killing the supervisor closes the job and the operating system takes every
// process in it — the shell, the runtime, and the runtime's children — with
// nobody having to walk a tree that is already coming apart.
//
// The supervisor is a short PowerShell program that makes the four calls
// Windows asks for. It runs the command with the handles it was given, so the
// output still arrives on the same pipe, and it exits with the command's exit
// code, so nothing downstream has to learn a new shape.

/** The environment variable the payload travels in. */
export const JOB_PAYLOAD_ENV = "STRATA_DEV_JOB_PAYLOAD";

/**
 * The supervisor.
 *
 * Everything it needs comes in one base64 payload — the command to run and the
 * directory to run it in — so no quoting question can reach the command line,
 * and the script itself is a constant that can be cached by the shell that
 * starts it.
 *
 * The one thing worth reading closely is how the startup block is built. A
 * STARTUPINFO is 104 bytes of pointers and flags, and the marshaller that
 * hands a PowerShell struct to the operating system does not always lay it
 * out the way the header says. The block is therefore written by hand into a
 * buffer of zeroes: the size in the first field, the handle flags at the
 * right offset, and the three standard handles where the header puts them.
 */
const JOB_SCRIPT = `
$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Runtime.InteropServices;

public static class StrataJob
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(IntPtr app, IntPtr command, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, IntPtr cwd, IntPtr startup, IntPtr processInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetStdHandle(int which);
}
'@

Add-Type -TypeDefinition $src -Language CSharp

function New-Buffer([int]$bytes) {
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes)
    $zero = New-Object byte[] $bytes
    [Runtime.InteropServices.Marshal]::Copy($zero, 0, $p, $bytes)
    return $p
}

function New-Text([string]$text) {
    # The buffer is sized to the text: a command line longer than a fixed
    # buffer would be copied past its end, and the supervisor would die in a
    # way that looks like the command was wrong.
    $bytes = [Text.Encoding]::Unicode.GetBytes($text + [char]0)
    $p = New-Buffer ([Math]::Max(64, $bytes.Length))
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
    return $p
}

function Quote-Arg([string]$arg) {
    if ($arg -eq "") { return '""' }
    if ($arg -notmatch '[\s"]') { return $arg }
    $escaped = $arg -replace '(\\\\*)"', '$1$1\\"'
    $escaped = $escaped -replace '(\\\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

$payload = $env:${JOB_PAYLOAD_ENV}
if (-not $payload) { exit 127 }
$parsed = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))) | ConvertFrom-Json
$argv = @($parsed.argv)
$cwd = [string]$parsed.cwd

$job = [StrataJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { exit 127 }

# JOB_OBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64 and LimitFlags is
# the third field, sixteen bytes in. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is
# what makes the job die with the handle that owns it.
$limits = New-Buffer 144
[Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x00002000)
if (-not [StrataJob]::SetInformationJobObject($job, 9, $limits, 144)) { exit 127 }

$commandLine = ($argv | ForEach-Object { Quote-Arg $_ }) -join " "

$startup = New-Buffer 104
[Runtime.InteropServices.Marshal]::WriteInt32($startup, 0, 104)
[Runtime.InteropServices.Marshal]::WriteInt32($startup, 60, 0x00000100)
[Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 80, [StrataJob]::GetStdHandle(-10))
[Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 88, [StrataJob]::GetStdHandle(-11))
[Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 96, [StrataJob]::GetStdHandle(-12))

$processInfo = New-Buffer 24
[Runtime.InteropServices.Marshal]::WriteInt32($processInfo, 0, 24)

$created = [StrataJob]::CreateProcessW((New-Text $argv[0]), (New-Text $commandLine), [IntPtr]::Zero, [IntPtr]::Zero, $true, 0x00000004, [IntPtr]::Zero, (New-Text $cwd), $startup, $processInfo)
if (-not $created) { exit 126 }

$handle = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)
$thread = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 8)

# Assigned before the first instruction runs, so the command cannot slip out
# of the job between the create and the assignment.
if (-not [StrataJob]::AssignProcessToJobObject($job, $handle)) { exit 125 }
[void][StrataJob]::ResumeThread($thread)

[void][StrataJob]::WaitForSingleObject($handle, [uint32]::MaxValue)
$code = 0
[void][StrataJob]::GetExitCodeProcess($handle, [ref]$code)
exit ([int]$code)
`;

/** The command the supervisor runs, and the environment it needs. */
export type JobPlan = {
  /** The program to start. */
  file: string;
  /** Its arguments. */
  args: string[];
  /** Extra environment for the child. */
  env: Record<string, string>;
};

/**
 * The supervisor invocation for a command, or nothing when this platform does
 * not need one.
 *
 * Only Windows needs it: everywhere else the child is its own process group
 * leader, and a signal to the group reaches the whole tree by itself.
 */
export function jobPlan(argv: string[], cwd: string, shellPath: string | undefined): JobPlan | undefined {
  if (process.platform !== "win32") return undefined;
  if (!shellPath) return undefined;
  const payload = JSON.stringify({ argv, cwd });
  return {
    file: shellPath,
    // -EncodedCommand takes base64 of UTF-16LE, which is the one encoding
    // that cannot mangle a command on the way in.
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(JOB_SCRIPT, "utf16le").toString("base64"),
    ],
    env: {
      [JOB_PAYLOAD_ENV]: Buffer.from(payload, "utf8").toString("base64"),
    },
  };
}
