// Tickets for the MCP endpoints ACP sessions are handed.
//
// ACP announces its MCP servers in `session/new`, before the session exists;
// a tool call can only arrive once the agent has one. A ticket is the bit in
// between: an opaque id in the URL, bound to a casf session id the moment the
// agent answers.
//
// The ticket is also the authorization: it is minted per session by the
// service, is unguessable, and maps to exactly one session. That is a narrower
// thing than the global API token, and the only thing an agent's MCP client
// ever holds — which is why the endpoint is exempt from the header check.

import { randomUUID } from "node:crypto";

export interface McpTickets {
  /** A fresh endpoint for one session, to be bound once the id exists. */
  open(): { name: string; url: string; headers?: Record<string, string>; bind(casfSessionId: string): void };
  /** The session a ticket stands for, when it has been bound. */
  sessionOf(ticket: string): string | undefined;
  /** Drop a ticket; called when its ACP session closes. */
  close(ticket: string): void;
}

export interface McpTicketsOptions {
  /** The service's own loopback base, e.g. `http://127.0.0.1:54037`. */
  baseUrl: () => string;
}

/** Bound tickets expire so a crashed agent does not accumulate endpoints. */
const TICKET_TTL_MS = 12 * 60 * 60_000;

export function createMcpTickets(options: McpTicketsOptions): McpTickets {
  const tickets = new Map<string, { sessionId?: string; expires: number }>();

  const dropExpired = () => {
    const now = Date.now();
    for (const [id, row] of tickets) if (row.expires <= now) tickets.delete(id);
  };

  return {
    open() {
      dropExpired();
      const ticket = randomUUID();
      tickets.set(ticket, { expires: Date.now() + TICKET_TTL_MS });
      const url = `${options.baseUrl().replace(/\/+$/, "")}/plugins/mcp?session=${encodeURIComponent(ticket)}`;
      return {
        name: "strata",
        url,
        bind(casfSessionId: string) {
          const row = tickets.get(ticket);
          if (row) row.sessionId = casfSessionId;
        },
      };
    },
    sessionOf(ticket) {
      const row = tickets.get(ticket);
      if (!row || row.expires <= Date.now()) return undefined;
      return row.sessionId;
    },
    close(ticket) {
      tickets.delete(ticket);
    },
  };
}
