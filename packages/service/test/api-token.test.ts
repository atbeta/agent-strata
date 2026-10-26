import { afterEach, describe, expect, test } from "bun:test";
import { startService } from "../src/index";

/**
 * The capability token the local API asks for.
 *
 * The service drives agents and reads files on this machine, so the loopback
 * address is not a boundary on its own. A token the desktop generates per
 * launch turns "something on this machine" into "the shell that started this
 * service".
 */
describe("the capability token", () => {
  const services: Array<ReturnType<typeof startService>> = [];
  const started = (apiToken?: string) => {
    const svc = startService({ db: ":memory:", port: 0, apiToken });
    services.push(svc);
    return `http://127.0.0.1:${svc.port}`;
  };

  afterEach(() => {
    for (const svc of services.splice(0)) svc.stop();
  });

  test("the health check is answerable without the token", async () => {
    // A probe that has to hold a secret to ask whether the service is up is a
    // probe nobody makes.
    const base = started("secret-test-token");
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  test("a request without the token is refused", async () => {
    const base = started("secret-test-token");
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a request with the wrong token is refused", async () => {
    const base = started("secret-test-token");
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-the-token",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("the bearer header is the way in", async () => {
    const base = started("secret-test-token");
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-test-token",
      },
      body: JSON.stringify({}),
    });
    // The body is empty, so the connect is refused for that — but it got
    // past the token, which is what this is about.
    expect(res.status).not.toBe(401);
  });

  test("the token header is the way in too", async () => {
    const base = started("secret-test-token");
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-strata-token": "secret-test-token",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });

  test("a service without a token asks for nothing", async () => {
    const base = started();
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });

  test("the stream takes the token in the query, because a browser cannot send a header", async () => {
    const base = started("secret-test-token");
    const controller = new AbortController();
    const res = await fetch(`${base}/stream?token=secret-test-token`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();

    const refused = await fetch(`${base}/stream`);
    expect(refused.status).toBe(401);
  });

  test("the preflight is answered before the token is asked for", async () => {
    // A browser sends the preflight without credentials; answering it with a
    // 401 would fail the request before it was ever made.
    const base = started("secret-test-token");
    const res = await fetch(`${base}/connect`, {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
