// Reads through strata's OpenCode extension plane the way the desktop does:
// the connection says it carries the extension, one of its sessions can list
// commands, find a file and name its branch, the connection can be read
// directly, and a path off the allow-list is refused. Nothing is written.
//
//   bun run scripts/probe-extension.ts
//
// STRATA_URL (default http://127.0.0.1:7700), PROBE_DIR (default the current
// directory: a session in it is preferred).

const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const dir = norm(process.env.PROBE_DIR ?? process.cwd());
const get = (p: string) => fetch(`${ST}${p}`);

const { connections } = (await get("/connections").then((r) => r.json())) as {
  connections: { id: string; capabilities: { extension?: string } }[];
};
const conn = connections.find((c) => c.capabilities.extension === "opencode");
const { sessions } = (await get("/sessions?backend=opencode&limit=200").then((r) => r.json())) as {
  sessions: { summary: { session_id: string }; workspace?: string }[];
};
const real = sessions.filter((s) => s.workspace && s.workspace !== "unknown" && s.workspace !== "no workspace");
const session = real.find((s) => norm(s.workspace!) === dir) ?? real[0];
const at = (p: string) => `/sessions/${encodeURIComponent(session!.summary.session_id)}/opencode${p}`;

const listed = session ? ((await get(at("/command")).then((r) => r.json())) as unknown) : [];
const commands = Array.isArray(listed) ? (listed as { name: string }[]) : [];
const files = session ? ((await get(at("/find/file?query=package.json&limit=5")).then((r) => r.json())) as unknown) : null;
const vcs = session ? ((await get(at("/vcs")).then((r) => r.json())) as { branch?: string | null }) : {};
const offList = session ? (await get(at("/config"))).status : 0;
const viaConnection = conn ? (await get(`/connections/${encodeURIComponent(conn.id)}/opencode/path`)).status : 0;
const crossSite = session
  ? (await fetch(`${ST}${at("/vcs")}`, { headers: { origin: "https://evil.example" } })).status
  : 0;

const report = {
  connection: conn?.id ?? null,
  session: session?.summary.session_id ?? null,
  workspace: session?.workspace ?? null,
  commands: commands.map((c) => c.name),
  files,
  branch: vcs.branch ?? null,
  off_list_status: offList,
  connection_read_status: viaConnection,
  cross_site_status: crossSite,
};
console.log(JSON.stringify(report, null, 2));
const ok =
  conn !== undefined &&
  session !== undefined &&
  commands.some((c) => c.name === "init") &&
  Array.isArray(files) &&
  offList === 404 &&
  viaConnection === 200 &&
  crossSite === 403;
process.exit(ok ? 0 : 1);
