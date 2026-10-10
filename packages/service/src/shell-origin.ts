// The service drives agents and reads files on this machine, so it is not
// reachable from any page the user happens to visit: only the desktop shell's
// origins get CORS. The last two are `tauri dev`, whose page comes from the
// Vite port in apps/desktop/src-tauri/tauri.conf.json.
const SHELL_ORIGINS: ReadonlySet<string> = new Set([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://localhost:5178",
  "http://127.0.0.1:5178",
]);

/** A Host naming anything else is a DNS-rebound page, not this machine's shell. */
export function isLoopbackHost(host: string | null): boolean {
  return host !== null && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

export function shellCors(origin: string | null): Record<string, string> {
  return origin !== null && SHELL_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, vary: "origin" }
    : {};
}

/**
 * A page on another site can make the browser send a request it cannot read
 * (an image, a no-cors fetch). It still should not reach the backend.
 */
export function fromAnotherSite(origin: string | null, fetchSite: string | null): boolean {
  if (origin !== null && SHELL_ORIGINS.has(origin)) return false;
  return origin !== null || (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none");
}

/** A browser request strata must refuse: a rebound Host, or another site's page. */
export function refused(req: Request): boolean {
  return (
    !isLoopbackHost(req.headers.get("host")) ||
    fromAnotherSite(req.headers.get("origin"), req.headers.get("sec-fetch-site"))
  );
}
