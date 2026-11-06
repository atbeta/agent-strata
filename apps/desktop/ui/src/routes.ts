import { settingsPath } from "./settings-sections";

export type Route =
  | { name: "fleet" }
  | { name: "session"; id: string }
  | { name: "compare"; a: string; b: string }
  | { name: "settings"; section?: string };

/**
 * The session a screen came from, as the href that goes back to it.
 *
 * Settings is reached from wherever the reader was, and it has no session of
 * its own — so the way back has to name one. A session that has since been
 * deleted is not a way back: the link is withheld rather than opening an
 * empty transcript.
 */
export function sessionBackHref(
  id: string | undefined,
  exists: (id: string) => boolean,
): string | undefined {
  if (!id || !exists(id)) return undefined;
  return `/session/${encodeURIComponent(id)}`;
}

export function parseHash(): Route {
  const h = location.hash.slice(1);
  const s = h.match(/^\/session\/(.+)$/);
  if (s) return { name: "session", id: decodeURIComponent(s[1]!) };
  const c = h.match(/^\/compare\/([^/]+)\/(.+)$/);
  if (c) return { name: "compare", a: decodeURIComponent(c[1]!), b: decodeURIComponent(c[2]!) };
  const settings = settingsPath(h);
  if (settings) return { name: "settings", section: settings.section };
  return { name: "fleet" };
}
