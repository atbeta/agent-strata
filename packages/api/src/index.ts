import { z } from "zod";

export const PermissionResponse = z.object({
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "always"]).optional(),
}).strict();
export type PermissionResponse = z.infer<typeof PermissionResponse>;

export const QuestionResponse = z.object({
  decision: z.enum(["reply", "reject"]),
  answers: z.array(z.array(z.string())).optional(),
}).strict();
export type QuestionResponse = z.infer<typeof QuestionResponse>;

export const DevStopResult = z.object({
  stopped: z.boolean(),
  clean: z.boolean(),
  residual: z.array(z.number()),
  port: z.number().optional(),
  port_free: z.boolean().optional(),
}).strict();
export type DevStopResult = z.infer<typeof DevStopResult>;

export interface ProviderPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: { label: string; value: string }[];
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderMethod {
  index: number;
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderPrompt[];
}

export interface ApiProvider {
  id: string;
  name: string;
  connected: boolean;
  methods: ProviderMethod[];
  canKey: boolean;
}

export interface OAuthStart {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export type OpencodeLaunchMode = "embed" | "external";
export type OpencodeLaunchState =
  | "starting"
  | "running"
  | "missing"
  | "restarting"
  | "stopped"
  | "external"
  | "authRequired"
  | "authFailed"
  | "unmanaged";
export type OpencodeRuntimeSource = "setting" | "env" | "path" | "missing" | "external";

export interface OpencodeRuntime {
  source: OpencodeRuntimeSource;
  bin?: string;
  version?: string;
  error?: string;
  /** Unix seconds; the UI formats it in the reader's zone. */
  checked_at?: number;
}

export interface OpencodeLaunch {
  mode: OpencodeLaunchMode;
  state: OpencodeLaunchState;
  url?: string;
  runtime?: OpencodeRuntime;
}
