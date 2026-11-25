import type { Connection } from "./api";
import { t } from "./i18n";
import { endpointShort } from "./use-connections";

/** What a connection is called wherever the reader picks one: the engine by its role, a server by its name. */
export function connectionName(conn: Pick<Connection, "placement" | "name" | "baseUrl">): string {
  if (conn.placement === "embed") return t("sidebar.source.local");
  return conn.name || endpointShort(conn.baseUrl);
}
