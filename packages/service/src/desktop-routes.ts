import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { editorLaunch } from "./editor";
import { checkPaths } from "./paths";
import {
  isOpencodeMode,
  readDesktopJson,
  readOpencodeStatus,
  readWorktreeRoot,
} from "./opencode-status";
import { revealTarget } from "./reveal";
import { writeSecureJson } from "./secure-write";
import { worktreeRoots } from "./worktree";

/**
 * Every folder a reveal or a path probe may name.
 *
 * The worktree roots belong here for the same reason the workspace folders do:
 * a checkout the app created is a folder the reader works in, and "show in
 * folder" on one it just made must not be refused as outside. The legacy root
 * is included even when the setting points elsewhere — a checkout made before
 * the setting existed still lives there.
 */
function revealRoots(
  desktopDir: string,
  dirs: Iterable<{ directory: string }>,
): string[] {
  return [
    homedir(),
    ...[...dirs].map((dir) => dir.directory),
    ...worktreeRoots(desktopDir, readWorktreeRoot(desktopDir)),
  ];
}

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
    const target = revealTarget(body?.path, revealRoots(deps.desktopDir, dirs.values()));
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
    const checks = checkPaths(list, revealRoots(deps.desktopDir, dirs.values()));
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

  /**
   * Where new checkouts go.
   *
   * The folder is checked before it is stored, because the failure it guards
   * against surfaces far from here: `git worktree add` on a path the reader
   * cannot write fails with git's own sentence at the moment they press the
   * button, and nothing on that screen says the root is the reason. Refusing
   * to save says it while they are still looking at the field.
   *
   * An empty value clears the setting rather than storing one — that is how
   * the field goes back to the state dir's own `worktrees`.
   */
  if (path === "/desktop/worktree-root" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
    const raw = typeof body?.path === "string" ? body.path.trim() : "";
    if (raw) {
      if (raw.includes("\0")) {
        return Response.json({ error: "path must not contain a null byte" }, { status: 400 });
      }
      if (!isAbsolute(raw)) {
        return Response.json({ error: "path must be absolute" }, { status: 400 });
      }
      const target = resolve(raw);
      try {
        mkdirSync(target, { recursive: true });
      } catch {
        return Response.json({ error: "path cannot be created" }, { status: 400 });
      }
      // `mkdirSync` succeeding does not mean it is writable: an existing
      // directory the reader may only read is created-in-place without error.
      try {
        const probe = join(target, `.strata-write-probe-${process.pid}`);
        writeFileSync(probe, "");
        rmSync(probe, { force: true });
      } catch {
        return Response.json({ error: "path is not writable" }, { status: 400 });
      }
    }
    const previous = readDesktopJson(join(deps.desktopDir, "desktop.json"));
    const base =
      previous && typeof previous === "object" && !Array.isArray(previous)
        ? { ...(previous as Record<string, unknown>) }
        : {};
    if (raw) base.worktreeRoot = resolve(raw);
    else delete base.worktreeRoot;
    mkdirSync(deps.desktopDir, { recursive: true });
    writeSecureJson(join(deps.desktopDir, "desktop.json"), base);
    return Response.json({ worktreeRoot: raw ? resolve(raw) : null });
  }

  return undefined;
}
