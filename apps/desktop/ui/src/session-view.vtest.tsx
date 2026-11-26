import { expect, test, vi } from "vitest";
import { createRoot } from "solid-js";
import { useSessionView } from "./session-view";

test("an empty session does not mount in the importing state", () => {
  vi.stubGlobal("fetch", async () => Response.json({ turns: [] }));
  const dispose = createRoot((dispose) => {
    const view = useSessionView(
      { id: "opencode:ses_empty" },
      { replayPos: () => null, generating: () => false },
    );
    expect(view.importing()).toBe(false);
    return dispose;
  });
  dispose();
  vi.unstubAllGlobals();
});
