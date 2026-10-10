// Sends what the desktop composer sends, through strata, to a running
// OpenCode: a prompt naming a workspace file with @, a prompt with an image,
// a custom command from the workspace, and a command that does not exist.
// It creates a real session in a scratch directory, spends a few hundred
// tokens on the server's default model (which must accept images), then
// deletes the session.
//
//   bun run scripts/probe-composer.ts
//
// STRATA_URL (default http://127.0.0.1:7700).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
// 32×32 solid red
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAvSURBVFhH7c6hAQAACMOw/f/08BwAJqKmKmnSz7LHdQAAAAAAAAAAAAAAAAAAAANUDfhqnpuFxwAAAABJRU5ErkJggg==";

type Block = { type: string; text?: string; path?: string; data?: string };
type View = { busy?: boolean; turns: { user?: Block[]; assistant: { content: Block[]; partial?: boolean }[] }[] };

const scratch = join(tmpdir(), `strata-composer-probe-${Date.now()}`);
mkdirSync(join(scratch, ".opencode", "command"), { recursive: true });
writeFileSync(join(scratch, "hello.txt"), "the secret word is pomegranate\n");
writeFileSync(
  join(scratch, ".opencode", "command", "echo.md"),
  "---\ndescription: Echo the arguments back\n---\nReply with exactly the following words and nothing else, no tools: $ARGUMENTS\n",
);

const post = (p: string, body: unknown) =>
  fetch(`${ST}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const { connections } = (await fetch(`${ST}/connections`).then((r) => r.json())) as {
  connections: { id: string; backend: string }[];
};
const conn = connections.find((c) => c.backend === "opencode");
if (!conn) {
  console.log(JSON.stringify({ error: "no opencode connection" }));
  process.exit(1);
}
const created = (await post("/sessions", { directory: scratch, title: "strata composer probe", connection_id: conn.id }).then(
  (r) => r.json(),
)) as { id: string };
const sid = created.id;
const at = (p: string) => `/sessions/${encodeURIComponent(sid)}${p}`;
const view = () => fetch(`${ST}${at("/view")}`).then((r) => r.json()) as Promise<View>;
const finished = (v: View) => v.turns.flatMap((t) => t.assistant).filter((a) => !a.partial).length;
const textOf = (blocks: Block[] = []) =>
  blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

/** Runs `send` and waits until one more assistant message has finished and the session is idle. */
async function turn(send: () => Promise<Response>) {
  const before = finished(await view());
  const res = await send();
  const status = res.status;
  if (!res.ok) return { status, error: await res.text() };
  let seenBusy = false;
  for (let waited = 0; waited < 90_000; waited += 700) {
    await Bun.sleep(700);
    const v = await view();
    seenBusy ||= v.busy === true;
    if (finished(v) > before && v.busy !== true) {
      const last = v.turns[v.turns.length - 1]!;
      return { status, user: last.user ?? [], reply: last.assistant.map((a) => textOf(a.content)).join("\n"), seenBusy };
    }
  }
  return { status, error: "no reply within 90 s" };
}

const caps = (await fetch(`${ST}${at("/capabilities")}`).then((r) => r.json())) as {
  commands?: boolean;
  attachments?: boolean;
};

const fileText = "@hello.txt what is the secret word? Answer with one word, no tools.";
const file = await turn(() =>
  post(at("/prompt"), {
    parts: [
      { type: "text", text: fileText },
      { type: "file_ref", path: "hello.txt", mention: { start: 0, end: 10 } },
    ],
  }),
);

const image = await turn(() =>
  post(at("/prompt"), {
    parts: [
      { type: "text", text: "Is this image red, green or blue? Answer with one of those words, no tools." },
      { type: "attachment", mime: "image/png", url: `data:image/png;base64,${RED_PNG}`, filename: "red.png" },
    ],
  }),
);

let commandMs = 0;
const command = await turn(async () => {
  const t0 = Date.now();
  const res = await post(at("/command"), { command: "echo", arguments: "banana split sundae" });
  commandMs = Date.now() - t0;
  return res;
});

const unknown = (await post(at("/command"), { command: "no-such-command" })).status;

await fetch(`${ST}${at("")}`, { method: "DELETE" });

const leaked = (blocks: Block[] = []) =>
  blocks.some((b) => b.type === "text" && /<content>|Called the Read tool/.test(b.text ?? ""));
const checks = {
  capabilities: caps.commands === true && caps.attachments === true,
  file_user_text: "user" in file && textOf(file.user) === fileText,
  file_user_ref: "user" in file && file.user!.some((b) => b.type === "file_ref" && b.path === "hello.txt"),
  file_no_contents: "user" in file && !leaked(file.user),
  file_reply: "reply" in file && /pomegranate/i.test(file.reply ?? ""),
  image_user_block: "user" in image && image.user!.some((b) => b.type === "image" && !!b.data),
  image_reply: "reply" in image && /red/i.test(image.reply ?? ""),
  command_started: command.status === 200 && commandMs < 5000,
  command_reply: "reply" in command && /banana/i.test(command.reply ?? ""),
  unknown_command_400: unknown === 400,
};
const brief = (r: Record<string, unknown>) => ({
  ...r,
  user: Array.isArray(r.user) ? (r.user as Block[]).map((b) => ({ ...b, data: b.data ? `${b.data.length} chars` : undefined })) : undefined,
});
console.log(
  JSON.stringify(
    { session: sid, scratch, checks, file: brief(file), image: brief(image), command: { ...brief(command), ms: commandMs }, unknown },
    null,
    2,
  ),
);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
