import type { OpencodeRuntime } from "./api";
import { inDesktopShell } from "./shell";

/**
 * The shell, not the service, owns the binary. These commands re-inspect it and
 * save a chosen path; neither starts or restarts anything, because a running
 * server keeps the binary it was launched with.
 */
export async function checkOpencodeRuntime(): Promise<OpencodeRuntime | undefined> {
  if (!inDesktopShell()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OpencodeRuntime>("opencode_runtime");
}

export async function setOpencodeBinary(path: string | null): Promise<OpencodeRuntime | undefined> {
  if (!inDesktopShell()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OpencodeRuntime>("set_opencode_bin", { path });
}

/** The native picker; the title is passed in so the caller can localize it. */
export async function chooseOpencodeBinary(title: string): Promise<string | null> {
  if (!inDesktopShell()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, title });
  return typeof picked === "string" ? picked : null;
}

/** Ask the shell's supervisor to replace the embedded server. */
export async function restartOpencode(): Promise<void> {
  if (!inDesktopShell()) throw new Error("desktop only");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_opencode");
}

/**
 * Answer the embedded server's domain login prompt. The forked CLI reads the
 * pair from stdin before it will serve; a refusal keeps the prompt parked and
 * flips the launch state to authFailed so the form can be submitted again.
 */
export async function opencodeLogin(username: string, password: string): Promise<void> {
  if (!inDesktopShell()) throw new Error("desktop only");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("opencode_login", { username, password });
}

/** Open the shell/OpenCode log; returns the path that was opened. */
export async function openOpencodeLog(): Promise<string> {
  if (!inDesktopShell()) throw new Error("desktop only");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("open_log_file");
}
