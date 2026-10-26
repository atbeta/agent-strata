// The capability token the local API expects.
//
// The service drives agents and reads files on this machine, so the loopback
// address is not a boundary on its own: anything running on the machine can
// reach it. A token the desktop generates per launch turns "something on this
// machine" into "the shell that started this service", which is a much smaller
// set.
//
// The token is optional. A service started by hand — from a terminal, or in a
// test — runs without one and nothing asks for it. The desktop always sets
// one, and the shell is the only thing that knows its value.

/** The token: the options first, the environment second, nothing otherwise. */
export function readApiToken(opts?: { apiToken?: string }): string | undefined {
  const fromOpts = opts?.apiToken?.trim();
  if (fromOpts) return fromOpts;
  const fromEnv = process.env.STRATA_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * A comparison that does not stop at the first difference.
 *
 * The token is a capability, and a comparison that gives up early says how
 * much of it was guessed. It costs nothing to read all of it.
 */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The bearer token a request carries, if it carries one. */
function bearerOf(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (!header) return undefined;
  const match = /^bearer\s+(.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Whether a request carries the token.
 *
 * Two ways to present it: the standard `Authorization: Bearer` header, and
 * `X-Strata-Token` for a client that cannot set the first one. No token
 * configured means no check at all — a service started by hand stays usable.
 */
export function tokenOk(req: Request, expected: string | undefined): boolean {
  if (!expected) return true;
  const bearer = bearerOf(req);
  if (bearer && sameToken(bearer, expected)) return true;
  const header = req.headers.get("x-strata-token")?.trim();
  return !!header && sameToken(header, expected);
}

/**
 * The token in the query string.
 *
 * A browser cannot put a header on an EventSource or on a WebSocket, so those
 * two requests carry the token in the URL instead. It is the same value, in
 * the one place the browser leaves no other choice.
 */
export function queryTokenOk(url: URL, expected: string | undefined): boolean {
  if (!expected) return true;
  const fromQuery = url.searchParams.get("token")?.trim();
  return !!fromQuery && sameToken(fromQuery, expected);
}
