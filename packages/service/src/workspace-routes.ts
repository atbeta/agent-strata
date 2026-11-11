import { reposOf, WorktreeError, worktreeAdd, worktreeRemove, withWorktrees } from "./worktree";

export async function workspaceRoute(
  req: Request,
  path: string,
  deps: {
    desktopDir: string;
    knownDirs(): Promise<Map<string, { directory: string; name?: string }>>;
    releaseInside(directory: string): Promise<void>;
  },
): Promise<Response | undefined> {
  const url = new URL(req.url);

  if (path === "/workspaces" && req.method === "GET") {
    const dirs = await deps.knownDirs();
    for (const dir of url.searchParams.getAll("dir")) {
      if (dir && !dirs.has(dir)) dirs.set(dir, { directory: dir });
    }
    return Response.json({ workspaces: await withWorktrees([...dirs.values()], deps.desktopDir) });
  }

  if (path === "/worktrees" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      directory?: string;
      name?: string;
      branch?: string;
    };
    if (!body.directory) return Response.json({ error: "directory required" }, { status: 400 });
    try {
      return Response.json(
        await worktreeAdd({
          dir: body.directory,
          name: body.name,
          branch: body.branch,
          stateDir: deps.desktopDir,
        }),
      );
    } catch (error) {
      const err = error instanceof WorktreeError ? error : new WorktreeError(String(error), 500);
      return Response.json({ error: err.message }, { status: err.status });
    }
  }

  if (path === "/worktrees/remove" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      directory?: string;
      force?: boolean;
    };
    if (!body.directory) return Response.json({ error: "directory required" }, { status: 400 });
    try {
      await worktreeRemove({
        dir: body.directory,
        force: body.force === true,
        stateDir: deps.desktopDir,
        repos: async () => reposOf([...(await deps.knownDirs()).values()]),
        release: () => deps.releaseInside(body.directory!),
      });
      return Response.json({ ok: true });
    } catch (error) {
      const err = error instanceof WorktreeError ? error : new WorktreeError(String(error), 500);
      return Response.json({ error: err.message }, { status: err.status });
    }
  }

  return undefined;
}
