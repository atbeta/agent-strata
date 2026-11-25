import { describe, expect, test } from "bun:test";
import { forgottenOrigins, SOURCE_COLORS, sourceTable } from "../src/sources";

const a = "opencode:http://192.168.5.101:14198";
const b = "opencode:https://opencode.example.com";
const embed1 = "opencode:embed:gen-1";
const embed2 = "opencode:embed:gen-2";

describe("sourceTable", () => {
  test("the local engine has no colour, whichever launch recorded it", () => {
    const source = sourceTable({ recorded: [embed1, a], live: [embed2] });
    expect(source(embed1)).toEqual({ local: true, name: "", connected: true });
    expect(sourceTable({ recorded: [embed1], live: [] })(embed1)?.connected).toBe(false);
  });

  test("a server keeps its colour when it disconnects, and is named by its host", () => {
    const up = sourceTable({ recorded: [embed1, a, b], live: [a] });
    const down = sourceTable({ recorded: [embed1, a, b], live: [] });
    expect(up(a)).toEqual({ color: 0, name: "192.168.5.101", connected: true });
    expect(down(a)).toEqual({ color: 0, name: "192.168.5.101", connected: false });
    expect(down(b)?.color).toBe(1);
  });

  test("a newcomer takes the next colour without moving anyone else's", () => {
    const fresh = "opencode:http://10.0.0.9:4096";
    const before = sourceTable({ recorded: [a, b], live: [fresh] });
    const after = sourceTable({ recorded: [a, b, fresh], live: [fresh] });
    expect([before(a)?.color, before(b)?.color, before(fresh)?.color]).toEqual([0, 1, 2]);
    expect([after(a)?.color, after(b)?.color, after(fresh)?.color]).toEqual([0, 1, 2]);
  });

  test("a saved name wins over the host; unknown and legacy records have no source", () => {
    const source = sourceTable({ recorded: [a], live: [], names: new Map([[a, "家里 101"]]) });
    expect(source(a)?.name).toBe("家里 101");
    expect(source(null)).toBeUndefined();
    expect(source("acp:acp://claude")).toBeUndefined();
  });

  test("colours repeat past the palette", () => {
    const many = Array.from({ length: SOURCE_COLORS + 1 }, (_, i) => `opencode:http://10.0.0.${i}:4096`);
    const source = sourceTable({ recorded: many, live: [] });
    expect(source(many[SOURCE_COLORS]!)?.color).toBe(0);
  });
});

describe("forgottenOrigins", () => {
  test("only a server neither connected nor remembered is left out", () => {
    const c = "opencode:http://10.0.0.9:4096";
    const recorded = [embed1, a, b, c, "acp:acp://claude"];
    expect(forgottenOrigins({ recorded, live: [a], remembered: [b] })).toEqual([c]);
    expect(forgottenOrigins({ recorded, live: [], remembered: [] })).toEqual([a, b, c]);
  });
});
