import type { Policy } from "@agent-strata/policy";
import type { BackendDriver } from "./driver";

export class ConnectionRegistry {
  private readonly conns = new Map<string, BackendDriver>();
  private readonly owners = new Map<string, string>();
  private readonly connPolicy = new Map<string, (sessionId: string) => Policy | undefined>();
  private readonly connPassword = new Map<string, string | undefined>();

  get size(): number {
    return this.conns.size;
  }

  values(): IterableIterator<BackendDriver> {
    return this.conns.values();
  }

  get(connectionId: string): BackendDriver | undefined {
    return this.conns.get(connectionId);
  }

  has(connectionId: string): boolean {
    return this.conns.has(connectionId);
  }

  add(
    driver: BackendDriver,
    policy: (sessionId: string) => Policy | undefined,
    password: string | undefined,
  ): void {
    this.conns.set(driver.id, driver);
    this.connPolicy.set(driver.id, policy);
    this.connPassword.set(driver.id, password);
  }

  remove(connectionId: string): BackendDriver | undefined {
    const driver = this.conns.get(connectionId);
    this.conns.delete(connectionId);
    this.connPolicy.delete(connectionId);
    this.connPassword.delete(connectionId);
    return driver;
  }

  clear(): void {
    this.conns.clear();
  }

  own(sessionId: string, connectionId: string): void {
    this.owners.set(sessionId, connectionId);
  }

  ownMany(sessionIds: string[], connectionId: string): void {
    for (const sessionId of sessionIds) this.own(sessionId, connectionId);
  }

  owns(sessionId: string): boolean {
    return this.owners.has(sessionId);
  }

  driverFor(sessionId: string): BackendDriver | undefined {
    const owned = this.owners.get(sessionId);
    if (owned) return this.conns.get(owned);
    if (this.conns.size === 1) return this.conns.values().next().value;
    const backend = sessionId.split(":")[0];
    const matches = [...this.conns.values()].filter((conn) => conn.backend === backend);
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolveSessionId(given: string): string {
    if (this.owners.has(given)) return given;
    for (const conn of this.conns.values()) {
      const candidate = `${conn.agent}:${given}`;
      if (this.owners.has(candidate)) return candidate;
    }
    return given;
  }

  policySourceFor(sessionId: string): ((sessionId: string) => Policy | undefined) | undefined {
    const driver = this.driverFor(sessionId);
    return driver ? this.connPolicy.get(driver.id) : undefined;
  }

  passwordOf(connectionId: string): string | undefined {
    return this.connPassword.get(connectionId);
  }
}
