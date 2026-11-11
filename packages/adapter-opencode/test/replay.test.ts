import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { expectAllowPath } from "./helpers";

// offline replay of a recorded real-server event stream
describe("live fixture replay", () => {
  test("opencode-live-deepseek.jsonl projects like the allow path", async () => {
    const text = await Bun.file(
      new URL("./fixtures/opencode-live-deepseek.jsonl", import.meta.url),
    ).text();
    const store = openStore(":memory:");
    const mapper = new OpencodeMapper({ directory: "/tmp/strata-e2e" });
    let sessionID = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as Event;
      for (const out of mapper.handle(evt)) {
        sessionID = out.session_id;
        store.append([out]);
      }
    }
    // fixture must end at the idle signal for its session
    const last = JSON.parse(
      text.trimEnd().split("\n").at(-1)!,
    ) as Event;
    const lastProps = last.properties as { sessionID?: string; status?: { type: string } };
    expect(lastProps.sessionID).toBe(sessionID.replace(/^opencode:/, ""));
    const idle =
      last.type === "session.idle" ||
      (last.type === "session.status" && lastProps.status?.type === "idle");
    expect(idle).toBe(true);

    const evs = store.read({ session_id: sessionID });
    expectAllowPath(evs);
    store.close();
  });
});