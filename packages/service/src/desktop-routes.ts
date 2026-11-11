import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { editorLaunch } from "./editor";
import { checkPaths } from "./paths";
import { isOpencodeMode, readDesktopJson, readOpencodeStatus } from "./opencode-status";
import { revealTarget } from "./reveal";
import { writeSecureJson } from "./secure-write";

export async function desktopRoute(
  req: Request,
  path: string,
  deps: {
    desktopDir: string;
    knownDirs(): Promise<Map<string, { directory: string; name?: string }>>;
  },
): Promise<Response | undefined> {
  const attachment = path.match(/^\/attachments\/([0-9a-f]{32})(\.[a-z0-9]{1,8})?$/);
  if (attachment && req.method === "GET") {
    const file = join(deps.desktopDir, "attachments", `${attachment[1]}${attachment[2] ?? ""}`);
    try {
      const bytes = readFileSync(file);
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    } catch {
      return Response.json({ error: "no such attachment" }, { status: 404 });
    }
  }

  if (path === "/desktop/editor" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { editor?: unknown; path?: unknown } | null;
    const target = editorLaunch(body?.editor, body?.path);
    if ("error" in target) return Response.json({ error: target.error }, { status: 400 });
    const bin = Bun.which(target.bin);
    if (!bin) return Response.json({ error: "editor is not installed" }, { status: 400 });
    try {
      Bun.spawn({ cmd: [bin, target.file], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  if (path === "/desktop/reveal" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
    const dirs = await deps.knownDirs();
    const roots = [homedir(), ...[...dirs.values()].map((dir) => dir.directory)];
    const target = revealTarget(body?.path, roots);
    if ("error" in target) return Response.json({ error: target.error, code: target.code }, { status: 400 });
    const bin = Bun.which(target.cmd[0]!);
    if (!bin) return Response.json({ error: "file manager is not available" }, { status: 400 });
    try {
      Bun.spawn({ cmd: [bin, ...target.cmd.slice(1)], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  if (path === "/desktop/paths" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { paths?: unknown } | null;
    const list = Array.isArray(body?.paths) ? body.paths.slice(0, 256) : [];
    const dirs = await deps.knownDirs();
    const roots = [homedir(), ...[...dirs.values()].map((dir) => dir.directory)];
    const checks = checkPaths(list, roots);
    return Response.json({
      paths: list.map((raw, index) => {
        const check = checks[index]!;
        return check.ok
          ? { path: String(raw), ok: true }
          : { path: String(raw), ok: false, code: check.code };
      }),
    });
  }

  if (path === "/desktop/opencode" && req.method === "GET") {
    const { username: _username, password: _password, ...launch } = readOpencodeStatus(deps.desktopDir);
    return Response.json(launch);
  }

  if (path === "/desktop/opencode" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = body?.mode;
    if (!isOpencodeMode(mode)) {
      return Response.json({ error: "mode must be embed or external" }, { status: 400 });
    }
    const previous = readDesktopJson(join(deps.desktopDir, "desktop.json"));
    const next =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...(previous as Record<string, unknown>), opencode: mode }
        : { opencode: mode };
    mkdirSync(deps.desktopDir, { recursive: true });
    writeSecureJson(join(deps.desktopDir, "desktop.json"), next);
    return Response.json({ mode, applied: "next-launch" });
  }

  return undefined;
}
