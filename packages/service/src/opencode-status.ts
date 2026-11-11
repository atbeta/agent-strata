import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpencodeLaunchMode, OpencodeLaunchState } from "@agent-strata/api";
import { sameEndpoint } from "./connection-phase";

export function isOpencodeMode(value: unknown): value is OpencodeLaunchMode {
  return value === "embed" || value === "external";
}

function isOpencodeState(value: unknown): value is OpencodeLaunchState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "missing" ||
    value === "restarting" ||
    value === "stopped" ||
    value === "external" ||
    value === "authRequired" ||
    value === "authFailed" ||
    value === "unmanaged"
  );
}

export function readDesktopJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readOpencodeMode(dir: string): OpencodeLaunchMode {
  const parsed = readDesktopJson(join(dir, "desktop.json"));
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const mode = (parsed as { opencode?: unknown }).opencode;
    if (isOpencodeMode(mode)) return mode;
  }
  return "embed";
}

export function autoConnectPlacement(
  opts: { autoConnect?: string; autoConnectPlacement?: "embed" | "external" },
  desktopDir: string,
): "embed" | "external" {
  if (opts.autoConnectPlacement) return opts.autoConnectPlacement;
  const launch = readOpencodeStatus(desktopDir);
  if (launch.url && opts.autoConnect && sameEndpoint(launch.url, opts.autoConnect)) return "embed";
  return "external";
}

type OpencodeRuntimeSource = "setting" | "env" | "path" | "missing" | "external";

interface OpencodeRuntime {
  source: OpencodeRuntimeSource;
  bin?: string;
  version?: string;
  error?: string;
  checked_at?: number;
}

function isRuntimeSource(value: unknown): value is OpencodeRuntimeSource {
  return (
    value === "setting" ||
    value === "env" ||
    value === "path" ||
    value === "missing" ||
    value === "external"
  );
}

function readOpencodeRuntime(dir: string): OpencodeRuntime | undefined {
  const parsed = readDesktopJson(join(dir, "opencode-runtime.json"));
  if (!parsed || typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as {
    source?: unknown;
    bin?: unknown;
    version?: unknown;
    error?: unknown;
    checked_at?: unknown;
  };
  if (!isRuntimeSource(rec.source)) return undefined;
  const runtime: OpencodeRuntime = { source: rec.source };
  if (typeof rec.bin === "string" && rec.bin) runtime.bin = rec.bin;
  if (typeof rec.version === "string" && rec.version) runtime.version = rec.version;
  if (typeof rec.error === "string" && rec.error) runtime.error = rec.error;
  if (typeof rec.checked_at === "number" && Number.isFinite(rec.checked_at)) {
    runtime.checked_at = rec.checked_at;
  }
  return runtime;
}

export function readOpencodeStatus(dir: string): {
  mode: OpencodeLaunchMode;
  state: OpencodeLaunchState;
  url?: string;
  runtime?: OpencodeRuntime;
  username?: string;
  password?: string;
} {
  const mode = readOpencodeMode(dir);
  const runtime = readOpencodeRuntime(dir);
  const parsed = readDesktopJson(join(dir, "opencode-status.json"));
  if (!parsed || typeof parsed !== "object" || parsed === null) {
    return runtime ? { mode, state: "unmanaged", runtime } : { mode, state: "unmanaged" };
  }
  const rec = parsed as {
    state?: unknown;
    url?: unknown;
    username?: unknown;
    password?: unknown;
  };
  if (!isOpencodeState(rec.state)) {
    return runtime ? { mode, state: "unmanaged", runtime } : { mode, state: "unmanaged" };
  }
  const body: {
    mode: OpencodeLaunchMode;
    state: OpencodeLaunchState;
    url?: string;
    runtime?: OpencodeRuntime;
    username?: string;
    password?: string;
  } = {
    mode,
    state: rec.state,
  };
  if (typeof rec.url === "string") body.url = rec.url;
  if (typeof rec.username === "string") body.username = rec.username;
  if (typeof rec.password === "string") body.password = rec.password;
  if (runtime) body.runtime = runtime;
  return body;
}
