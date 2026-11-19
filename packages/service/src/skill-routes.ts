import { isAbsolute, join, resolve } from "node:path";
import type { ConnectionRegistry } from "./connection-registry";
import { connectionPlacement } from "./connection-phase";
import { readOpencodeStatus } from "./opencode-status";
import {
  createSkill,
  deleteSkill,
  listSkills,
  publicSkill,
  SkillError,
  skillKey,
  updateSkill,
  type ActiveSkill,
  type ManagedRoot,
  type SkillInput,
  type SkillRecord,
} from "./skills";

interface SkillDeps {
  connections: ConnectionRegistry;
  desktopDir: string;
  opencodeConfigDir?: string;
  knownDirs(connectionId?: string): Promise<Map<string, { directory: string; name?: string }>>;
}

interface SkillContext {
  connection: NonNullable<ReturnType<ConnectionRegistry["get"]>>;
  workspace: string;
  local: boolean;
  roots: ManagedRoot[];
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function context(deps: SkillDeps, connectionId: string, workspace: string): Promise<SkillContext> {
  const connection = deps.connections.get(connectionId);
  if (!connection || connection.extension?.kind !== "opencode") {
    throw new SkillError("OpenCode connection not found", 404, "connection_not_found");
  }
  if (!isAbsolute(workspace)) throw new SkillError("workspace must be absolute", 400, "workspace_invalid");
  const known = await deps.knownDirs(connectionId);
  if (![...known.keys()].some((dir) => samePath(dir, workspace))) {
    throw new SkillError("workspace is not known to this connection", 400, "workspace_unknown");
  }
  const local =
    connectionPlacement(connection.backend, connection.baseUrl, readOpencodeStatus(deps.desktopDir)) === "embed";
  const roots: ManagedRoot[] = [
    {
      root: join(workspace, ".opencode", "skills"),
      source: "opencode-project",
      scope: "project",
      writable: local,
    },
  ];
  if (deps.opencodeConfigDir) {
    roots.push({
      root: join(deps.opencodeConfigDir, "skills"),
      source: "opencode-global",
      scope: "global",
      writable: local,
    });
  }
  return { connection, workspace, local, roots };
}

async function activeSkills(ctx: SkillContext): Promise<ActiveSkill[]> {
  const res = await ctx.connection.extension!.get("/skill", new URLSearchParams(), ctx.workspace);
  if (!res.ok) {
    throw new SkillError(
      res.status === 404 ? "this OpenCode does not expose skills" : "OpenCode skills request failed",
      res.status === 404 ? 404 : 502,
      res.status === 404 ? "skills_unavailable" : "upstream",
    );
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) throw new SkillError("OpenCode returned an invalid skill list", 502, "upstream");
  return body.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.location !== "string" || typeof row.content !== "string") return [];
    return [
      {
        name: row.name,
        description: typeof row.description === "string" ? row.description : undefined,
        location: row.location,
        content: row.content,
      },
    ];
  });
}

async function records(deps: SkillDeps, connectionId: string, workspace: string) {
  const ctx = await context(deps, connectionId, workspace);
  const active = await activeSkills(ctx);
  return { ctx, skills: listSkills({ connectionId, workspace, active, roots: ctx.roots, local: ctx.local }) };
}

function text(body: Record<string, unknown>, key: string, fallback: string): string {
  return typeof body[key] === "string" ? (body[key] as string) : fallback;
}

function input(body: Record<string, unknown>, current?: SkillRecord): SkillInput {
  return {
    name: text(body, "name", current?.name ?? ""),
    description: text(body, "description", current?.description ?? ""),
    content: text(body, "content", current?.content ?? ""),
    autoInvoke: typeof body.autoInvoke === "boolean" ? body.autoInvoke : (current?.autoInvoke ?? true),
  };
}

async function reloaded(ctx: SkillContext): Promise<boolean> {
  try {
    const responses = await Promise.all([
      ctx.connection.extension!.get("/skill", new URLSearchParams(), ctx.workspace),
      ctx.connection.extension!.get("/command", new URLSearchParams(), ctx.workspace),
    ]);
    for (const res of responses) await res.body?.cancel();
    return responses.every((res) => res.ok);
  } catch {
    return false;
  }
}

function failure(error: unknown): Response {
  if (error instanceof SkillError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function skillRoute(
  req: Request,
  path: string,
  deps: SkillDeps,
): Promise<Response | undefined> {
  if (path !== "/skills" && !/^\/skills\/[a-f0-9]{32}$/.test(path)) return undefined;
  const url = new URL(req.url);
  try {
    if (path === "/skills" && req.method === "GET") {
      const connectionId = url.searchParams.get("connection") ?? "";
      const workspace = url.searchParams.get("workspace") ?? "";
      if (!workspace) {
        const connection = deps.connections.get(connectionId);
        if (!connection || connection.extension?.kind !== "opencode") {
          throw new SkillError("OpenCode connection not found", 404, "connection_not_found");
        }
        const known = await deps.knownDirs(connectionId);
        return Response.json({
          workspaces: [...known.values()],
          connection: {
            id: connection.id,
            name: connection.name,
            local:
              connectionPlacement(connection.backend, connection.baseUrl, readOpencodeStatus(deps.desktopDir)) ===
              "embed",
          },
          globalAvailable: Boolean(deps.opencodeConfigDir),
        });
      }
      const result = await records(deps, connectionId, workspace);
      return Response.json({
        skills: result.skills.map(publicSkill),
        workspace: result.ctx.workspace,
        connection: {
          id: result.ctx.connection.id,
          name: result.ctx.connection.name,
          local: result.ctx.local,
        },
        globalAvailable: Boolean(deps.opencodeConfigDir),
      });
    }

    if (path === "/skills" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const connectionId = typeof body?.connection === "string" ? body.connection : "";
      const workspace = typeof body?.workspace === "string" ? body.workspace : "";
      const ctx = await context(deps, connectionId, workspace);
      const scope = body?.scope;
      if (scope !== "global" && scope !== "project") {
        throw new SkillError("scope must be global or project", 400, "skill_scope");
      }
      const root = ctx.roots.find((item) => item.scope === scope && item.writable);
      if (!root) throw new SkillError("this skill location is read-only", 403, "skill_readonly");
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      const location = createSkill(root, id, input(body ?? {}));
      return Response.json({ ok: true, key: skillKey(connectionId, resolve(location)), reloaded: await reloaded(ctx) });
    }

    const match = path.match(/^\/skills\/([a-f0-9]{32})$/);
    if (match && (req.method === "PATCH" || req.method === "DELETE")) {
      const connectionId = url.searchParams.get("connection") ?? "";
      const workspace = url.searchParams.get("workspace") ?? "";
      const result = await records(deps, connectionId, workspace);
      const record = result.skills.find((skill) => skill.key === match[1]);
      if (!record) throw new SkillError("skill not found", 404, "skill_not_found");
      if (req.method === "DELETE") deleteSkill(record);
      else {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) throw new SkillError("JSON body required", 400, "body_invalid");
        updateSkill(record, input(body, record));
      }
      return Response.json({ ok: true, reloaded: await reloaded(result.ctx) });
    }

    if (path === "/skills" || match) return Response.json({ error: "method not allowed" }, { status: 405 });
    return undefined;
  } catch (error) {
    return failure(error);
  }
}
