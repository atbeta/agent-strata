// One reading of "a URL an agent may open".
//
// Two places need this answer and both used to answer differently: the host's
// `guards.net` check decides whether a call may reach a plugin at all, and a
// plugin that opens pages decides whether it can. When they disagreed, the
// host won — and a tool documented as accepting `host:port` was refused before
// the plugin ever saw it. The rule now lives in one function so that cannot
// happen again.

export interface ParsedHttpUrl {
  /** The normalized `http(s)://…` form. */
  url: string;
  /** `host:port`, which is what an allowlist is written against. */
  host: string;
  error?: undefined;
}

export interface RejectedUrl {
  error: string;
  url?: undefined;
  host?: undefined;
}

/**
 * Parse a URL a tool may open.
 *
 * `localhost:3000` and `example.com` are accepted as their `http://` form: a
 * model reading "http(s) URL, or host:port" will type those, and an agent
 * driving a local dev server types them constantly. Anything with a scheme
 * other than http(s) is refused, including `javascript:` and `file:` — those
 * are not pages an agent should be opening, and the escape hatch for script is
 * the eval tool, not the address bar.
 *
 * A bare `host:port` needs care: `new URL("localhost:3000")` parses, with
 * `localhost:` as the *scheme*. Guessing from the string is what the old code
 * got wrong in both directions, so the rule is explicit — a scheme is only
 * honoured when it is followed by `//`.
 */
export function parseHttpUrl(raw: unknown): ParsedHttpUrl | RejectedUrl {
  if (typeof raw !== "string") return { error: "not a URL" };
  const text = raw.trim();
  if (!text) return { error: "not a URL" };

  const hasAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);

  // A colon is ambiguous: `localhost:3000` is a host and a port, while
  // `file:/etc/passwd` is a scheme and a path. The rule is what follows the
  // colon — a port is digits, and everything else is a scheme name. Without
  // this, `file:/etc/passwd` became the host `file` and a page that should have
  // been refused was fetched from the network instead.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(text);
  if (schemeMatch && !/^\d/.test(schemeMatch[2] ?? "")) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (scheme !== "http" && scheme !== "https") return { error: `unsupported scheme ${scheme}:` };
    // `http:example.com` has an authority in no browser's reading of it.
    if (!hasAuthority) return { error: "not a valid URL" };
  }

  const candidate = hasAuthority ? text : `http://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `unsupported scheme ${url.protocol}` };
  }
  // A URL that is only a scheme and a path (`http:foo`) has no host to open.
  if (!url.hostname) return { error: "not a valid URL" };
  if (url.username || url.password) return { error: "URLs with credentials are not allowed" };
  return { url: url.toString(), host: url.host };
}

/**
 * Whether a host matches one entry of a allowlist.
 *
 * Entries are hosts, optionally wildcards: `*` for everything, `*.example.com`
 * for a subdomain tree, or an exact `host:port`. The port matters, because the
 * thing being allowed is usually "the dev server on 3000", not the whole host.
 */
export function hostAllowed(host: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const target = host.toLowerCase();
  const name = target.split(":")[0] ?? "";
  for (const entry of allowlist) {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "*") return true;
    if (pattern === target) return true;
    // A bare host allows any port on it: `example.com` in a manifest is about
    // the site, and refusing `example.com:443` would refuse every real visit.
    if (!pattern.includes(":") && pattern === name) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (name.endsWith(suffix) || name === pattern.slice(2)) return true;
    }
  }
  return false;
}
