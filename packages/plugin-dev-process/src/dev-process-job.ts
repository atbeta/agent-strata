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
// supervisor puts itself in the job, then runs the command in-process, so
// every process the command spawns joins the job automatically. The job is
// marked to die when its last handle closes; the supervisor holds that
// handle, so killing the supervisor closes the job and the operating system
// takes every process in it — the shell, the runtime, and the runtime's
// children — with nobody having to walk a tree that is already coming apart.
//
// Running the command in-process also removes the second shell the older
// supervisor started through a hand-marshalled CreateProcessW call, which
// was both the fragile part and most of the startup cost.

/** The environment variable the payload travels in. */
export const JOB_PAYLOAD_ENV = "STRATA_DEV_JOB_PAYLOAD";

/**
 * The supervisor.
 *
 * Everything it needs comes in one base64 payload — the command to run and
 * the directory to run it in — so no quoting question can reach the command
 * line, and the script itself is a constant that can be cached by the shell
 * that starts it.
 *
 * The job helpers are four P/Invoke declarations, and `Add-Type` spends
 * real time compiling them every run, so the assembly is cached in temp
 * keyed on the source it was built from: the first command on a machine
 * pays the compile, every later one pays a load.
 */
const JOB_SCRIPT = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

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

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
}
'@

$hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($src)))).Replace("-", "").ToLower()
$dll = Join-Path ([IO.Path]::GetTempPath()) "strata-job-$hash.dll"
if (Test-Path $dll) {
    try {
        Add-Type -Path $dll
    } catch {
        # A stale or partial cache file compiles again rather than failing.
        Add-Type -TypeDefinition $src -Language CSharp
    }
} else {
    try {
        Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $dll
    } catch {
        Add-Type -TypeDefinition $src -Language CSharp
    }
}

function New-Buffer([int]$bytes) {
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes)
    $zero = New-Object byte[] $bytes
    [Runtime.InteropServices.Marshal]::Copy($zero, 0, $p, $bytes)
    return $p
}

$payload = $env:${JOB_PAYLOAD_ENV}
if (-not $payload) { exit 127 }
$parsed = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))) | ConvertFrom-Json
$command = [string]$parsed.command
$cwd = [string]$parsed.cwd

$job = [StrataJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { exit 127 }

# JOB_OBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64 and LimitFlags is
# the third field, sixteen bytes in. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is
# what makes the job die with the handle that owns it.
$limits = New-Buffer 144
[Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x00002000)
if (-not [StrataJob]::SetInformationJobObject($job, 9, $limits, 144)) { exit 127 }

# The supervisor joins its own job, so the command it runs — and everything
# the command spawns — is in the job without any CreateProcess marshalling.
if (-not [StrataJob]::AssignProcessToJobObject($job, [StrataJob]::GetCurrentProcess())) { exit 125 }

$ErrorActionPreference = "Continue"
Set-Location $cwd
try {
    Invoke-Expression $command
    if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
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
export function jobPlan(command: string, cwd: string, shellPath: string | undefined): JobPlan | undefined {
  if (process.platform !== "win32") return undefined;
  if (!shellPath) return undefined;
  const payload = JSON.stringify({ command, cwd });
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
