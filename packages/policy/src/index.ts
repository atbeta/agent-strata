import { z } from "zod";
import type { Event, EventInput } from "@agent-core/schema";

const Condition = z.object({
  matches: z.string().optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  glob: z.string().optional(),
});

export const PolicySchema = z.object({
  version: z.literal(1),
  default: z.enum(["ask", "allow", "deny"]).default("ask"),
  rules: z.array(
    z.object({
      id: z.string(),
      effect: z.enum(["allow", "deny", "ask"]),
      tool: z.string(),
      when: z.record(Condition).optional(),
      reason: z.string().optional(),
    }),
  ),
});
export type Policy = z.infer<typeof PolicySchema>;
type Rule = Policy["rules"][number];

export const SHELL_TOOLS = ["bash", "shell", "execute", "terminal"];

export interface Decision {
  decision: "allow" | "deny" | "ask";
  rule_id?: string;
  reason?: string;
}

export function loadPolicy(json: unknown): Policy {
  const policy = PolicySchema.parse(json);
  for (const r of policy.rules) {
    for (const [path, c] of Object.entries(r.when ?? {})) {
      if (c.matches !== undefined) {
        try {
          new RegExp(c.matches);
        } catch (e) {
          throw new Error(`invalid regex in rule "${r.id}" at "${path}": ${(e as Error).message}`);
        }
      }
    }
  }
  return policy;
}

function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function getPath(obj: unknown, dotPath: string): unknown {
  let cur = obj;
  for (const seg of dotPath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function whenMatches(rule: Rule, input: Record<string, unknown>): boolean {
  for (const [path, cond] of Object.entries(rule.when ?? {})) {
    const v = getPath(input, path);
    if (cond.equals !== undefined && v !== cond.equals) return false;
    if (cond.matches !== undefined) {
      if (typeof v !== "string" || !new RegExp(cond.matches).test(v)) return false;
    }
    if (cond.glob !== undefined) {
      if (typeof v !== "string" || !globToRe(cond.glob).test(v)) return false;
    }
  }
  return true;
}

function toolMatches(rule: Rule, tool: string): boolean {
  return globToRe(rule.tool).test(tool);
}

const EFFECT_RANK = { deny: 3, ask: 2, allow: 1 } as const;

function pickRule(policy: Policy, tool: string, input: Record<string, unknown>): Rule | undefined {
  const matching = policy.rules.filter(
    (r) => toolMatches(r, tool) && whenMatches(r, input),
  );
  matching.sort((a, b) => EFFECT_RANK[b.effect] - EFFECT_RANK[a.effect]);
  return matching[0];
}

function evalSingle(
  policy: Policy,
  tool: string,
  input: Record<string, unknown>,
): Decision {
  const rule = pickRule(policy, tool, input);
  if (!rule) {
    return { decision: policy.default, reason: "default" };
  }
  return { decision: rule.effect, rule_id: rule.id, reason: rule.reason ?? `matched rule ${rule.id}` };
}

export function splitShell(command: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        cur += c;
        continue;
      }
      if (c === "\\" && i + 1 < command.length) {
        cur += c + command[++i]!;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\") {
      cur += c + (command[++i] ?? "");
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      segs.push(cur);
      cur = "";
      continue;
    }
    if (c === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      if (prev === ">" || prev === "<" || next === ">") {
        cur += c;
        continue;
      }
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter((s) => s.length > 0);
}

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

function hasShellDashC(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const base = tokens[i]!.split("/").pop()!;
    if (SHELL_NAMES.has(base)) {
      for (let j = i + 1; j < tokens.length; j++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(tokens[j]!)) return true;
      }
    }
  }
  return false;
}

function hasUnanalyzableConstruct(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "'") {
      quote = "'";
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") return true;
    const two = command.slice(i, i + 2);
    if (two === "$(" || two === "<(" || two === ">(") return true;
  }
  if (/(^|[\s;|&])eval(\s|$)/.test(command)) return true;
  return false;
}

function hasOutputRedirection(segment: string): boolean {
  let quote: "'" | '"' | null = null;
  const targetAfter = (i: number): string => {
    let j = i;
    while (j < segment.length && segment[j] === ">") j++;
    if (segment[j] === "|") j++;
    if (segment[j] === "&") j++;
    while (j < segment.length && /\s/.test(segment[j]!)) j++;
    const start = j;
    while (j < segment.length && !/[\s&|;]/.test(segment[j]!)) j++;
    return segment.slice(start, j);
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "'") {
      quote = "'";
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) continue;
    if (c === "&" && segment[i + 1] === ">") {
      const t = targetAfter(i + 1);
      if (t !== "/dev/null") return true;
      continue;
    }
    if (c === ">") {
      const next = segment[i + 1];
      if (next === "&") {
        const after = segment[i + 2];
        if (after !== undefined && /[0-9-]/.test(after)) continue; // >&N fd dup
        const t = targetAfter(i + 1);
        if (t !== "/dev/null" && t !== "") return true;
        continue;
      }
      const t = targetAfter(i);
      if (t.startsWith("&")) {
        if (/^&[0-9-]/.test(t)) continue; // N>&M
        if (t === "/dev/null" || t === "&/dev/null") continue;
        return true;
      }
      if (t !== "/dev/null" && t !== "") return true;
    }
  }
  return false;
}

export function evaluate(
  policy: Policy,
  req: { tool: string; input: Record<string, unknown> },
): Decision {
  const { tool, input } = req;
  if (!SHELL_TOOLS.includes(tool)) return evalSingle(policy, tool, input);

  const raw = input.command ?? input.cmd;
  if (typeof raw !== "string") return evalSingle(policy, tool, input);

  const split = splitShell(raw);
  const segments = split.length ? split : [raw.trim()];
  const unanalyzable =
    hasUnanalyzableConstruct(raw) || segments.some(hasShellDashC);

  let firstDecision: Decision | undefined;
  let askDecision: Decision | undefined;
  for (const seg of segments) {
    const d = evalSingle(policy, tool, { ...input, command: seg });
    firstDecision ??= d;
    if (d.decision === "deny") return { decision: "deny", rule_id: d.rule_id, reason: d.reason };
    if (d.decision === "ask") askDecision ??= d;
  }
  if (askDecision) return askDecision;
  if (unanalyzable) {
    return { decision: "ask", reason: "unanalyzable shell construct" };
  }
  if (segments.some(hasOutputRedirection)) {
    return { decision: "ask", reason: "output redirection" };
  }
  return firstDecision ?? { decision: "allow", reason: "default" };
}

export function decide(policy: Policy, event: Event): EventInput | null {
  if (event.type !== "permission.requested") {
    throw new Error("decide() requires a permission.requested event");
  }
  const d = evaluate(policy, { tool: event.data.tool, input: event.data.input });
  if (d.decision === "ask") return null;
  return {
    session_id: event.session_id,
    ts: new Date().toISOString(),
    source: event.source,
    type: "permission.resolved",
    data: {
      request_id: event.data.request_id,
      decision: d.decision,
      by: "policy",
      scope: "once",
      rule_id: d.rule_id,
      reason: d.reason,
    },
  };
}
