import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "../src/connection-registry";
import type { BackendDriver } from "../src/driver";

const driver = (id: string) => ({ id, backend: "opencode" }) as unknown as BackendDriver;

function registry(origins: Record<string, string>, drivers: BackendDriver[]) {
  const conns = new ConnectionRegistry();
  for (const d of drivers) conns.add(d, () => undefined, undefined);
  const served = new Map([
    ["local", "opencode:embed:gen-1"],
    ["a", "opencode:http://a"],
    ["b", "opencode:http://b"],
  ]);
  conns.locate({
    originOf: (sessionId) => origins[sessionId],
    serves: (origin, d) => served.get(d.id) === origin,
  });
  return conns;
}

describe("ConnectionRegistry.driverFor", () => {
  test("a disconnected server's session is not handed to the one still connected", () => {
    const local = driver("local");
    const conns = registry({ "opencode:s1": "opencode:http://a" }, [local]);
    expect(conns.driverFor("opencode:s1")).toBeUndefined();
  });

  test("an unclaimed session goes to the server it was recorded from", () => {
    const a = driver("a");
    const b = driver("b");
    const conns = registry({ "opencode:s1": "opencode:http://b" }, [a, b]);
    expect(conns.driverFor("opencode:s1")).toBe(b);
  });

  test("a claim wins, and a session with no record keeps the old guess", () => {
    const local = driver("local");
    const a = driver("a");
    const conns = registry({ "opencode:s1": "opencode:http://b" }, [local]);
    expect(conns.driverFor("opencode:legacy")).toBe(local);
    conns.add(a, () => undefined, undefined);
    conns.own("opencode:s1", "a");
    expect(conns.driverFor("opencode:s1")).toBe(a);
  });
});
