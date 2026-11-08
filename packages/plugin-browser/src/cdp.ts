// A small Chrome DevTools Protocol client.
//
// Why not Playwright: it is ~40 MB of Node shims and its bundle cannot be
// compiled into the sidecar — the compile fails on `chromium-bidi` and
// `electron`, which are optional at runtime and unresolvable at build time.
// The design doc's fallback for that was "make the browser plugin a child
// process", but a plugin that needs none of it is better than a protocol
// escape hatch: CDP is a JSON-over-WebSocket protocol, Bun has a WebSocket,
// and the subset this needs is small.
//
// What is lost: real trusted input events (a click is a DOM click, not an OS
// one), and Playwright's auto-waiting. What is kept: a persistent profile, an
// adoptable window, tabs per session, snapshots with refs, screenshots and
// console capture — which is the whole tool surface.
//
// Transport shape: one browser-level socket, every page attached through it
// with `flatten: true`, so a page call carries a `sessionId` and no second
// connection has to be opened per tab.

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A protocol error the caller can read; distinct from a transport failure. */
export class CdpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class CdpConnection {
  private next = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly url: string,
  ) {}

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl);
    const connection = new CdpConnection(socket, wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // closing an unopened socket is not an error worth reporting
        }
        reject(new CdpError(`could not open ${wsUrl} within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new CdpError(`could not open ${wsUrl}`));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => connection.onMessage(String((event as MessageEvent).data)));
    socket.addEventListener("close", () => connection.onClose());
    socket.addEventListener("error", () => connection.onClose());
    return connection;
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(message.error.message ?? "protocol error", message.error.code));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.listeners.get(event.method) ?? []) {
      try {
        listener(event);
      } catch {
        // a listener that throws is a bug in this file, not a reason to drop
        // the connection and every tab with it
      }
    }
    for (const listener of this.listeners.get("*") ?? []) {
      try {
        listener(event);
      } catch {
        // same
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) pending.reject(new CdpError("the connection closed"));
    this.pending.clear();
    for (const listener of this.listeners.get("close") ?? []) {
      try {
        listener({ method: "close", params: {} });
      } catch {
        // nothing to do
      }
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  on(method: string, listener: (event: CdpEvent) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** One request, with a timeout so a wedged tab cannot hang a tool call. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the connection is closed"));
    const id = ++this.next;
    const body: Record<string, unknown> = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify(body));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new CdpError(String(e)));
      }
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
    this.onClose();
  }
}

/** A page, driven through a flattened session on the browser connection. */
export class CdpPage {
  constructor(
    private readonly connection: CdpConnection,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  /** Evaluate in this page's main world, by value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const answer = await this.send<{
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (answer.exceptionDetails) {
      const detail =
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "the page threw";
      throw new CdpError(detail.split("\n")[0] ?? detail);
    }
    return answer.result?.value as T;
  }

  /** Navigate and wait for the frame to load, bounded. */
  async navigate(url: string, timeoutMs = 20_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const offs = [
        this.connection.on("Page.loadEventFired", (event) => {
          if (event.sessionId === this.sessionId) {
            cleanup();
            resolve();
          }
        }),
        this.connection.on("Page.frameStoppedLoading", (event) => {
          if (event.sessionId === this.sessionId) {
            cleanup();
            resolve();
          }
        }),
      ];
      const cleanup = () => {
        for (const off of offs) off();
      };
      setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
    });
    const answer = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (answer.errorText) throw new CdpError(answer.errorText);
    await loaded;
  }

  async screenshot(format: "png" | "jpeg" = "png", quality?: number): Promise<Uint8Array> {
    const answer = await this.send<{ data: string }>("Page.captureScreenshot", {
      format,
      ...(quality !== undefined && format === "jpeg" ? { quality } : {}),
    });
    return Uint8Array.from(Buffer.from(answer.data, "base64"));
  }

  /**
   * Set the layout size the page believes it has.
   *
   * Headless still uses a real viewport; the rail is a different shape from
   * 1280x800, and a page laid out for a desktop window then scaled into a
   * narrow column is the "tiny screenshot" look this exists to avoid. Sizing
   * the page to the panel means text is the size it would be in a real
   * browser at that width.
   */
  async setViewport(width: number, height: number, scale = 1): Promise<void> {
    const w = Math.max(320, Math.round(width));
    const h = Math.max(320, Math.round(height));
    // `deviceScaleFactor` is the display's pixel ratio, not a zoom: the page
    // still lays out at `w`x`h` CSS pixels, and a screenshot comes back at
    // `w * scale`. With a factor of 1 on a retina display the frame was a
    // half-resolution bitmap stretched over twice the pixels — which is what
    // "糊" was.
    const factor = Math.min(Math.max(scale, 1), 2);
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: factor,
      mobile: false,
    });
  }

  /** The viewport size, for turning a panel's fractions into page pixels. */
  async viewport(): Promise<{ width: number; height: number }> {
    const metrics = await this.send<{ cssLayoutViewport?: { clientWidth: number; clientHeight: number } }>(
      "Page.getLayoutMetrics",
    ).catch(() => undefined);
    const view = metrics?.cssLayoutViewport;
    if (view && view.clientWidth > 0 && view.clientHeight > 0) {
      return { width: view.clientWidth, height: view.clientHeight };
    }
    const fallback = await this
      .evaluate<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })")
      .catch(() => undefined);
    return { width: fallback?.w || 1280, height: fallback?.h || 800 };
  }

  async url(): Promise<string> {
    return this.evaluate<string>("location.href").catch(() => "");
  }

  async title(): Promise<string> {
    return this.evaluate<string>("document.title").catch(() => "");
  }

  async close(): Promise<void> {
    await this.send("Page.close").catch(() => {});
  }

  /** Bring the tab to the front, so a person watching sees it. */
  async front(): Promise<void> {
    await this.send("Page.bringToFront").catch(() => {});
  }

  /**
   * Real input at page coordinates.
   *
   * CDP's `Input.dispatchMouseEvent` produces trusted events, which matters
   * for pages that gate on `isTrusted` or use pointer capture: a synthetic
   * DOM click is not the same thing to the page.
   */
  async click(x: number, y: number): Promise<void> {
    const base = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  async move(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  }

  async key(key: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, ...keyIdentity(key) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, ...keyIdentity(key) });
  }

  async typeText(text: string): Promise<void> {
    for (const char of text) await this.send("Input.insertText", { text: char });
  }
}

/**
 * The `windowsVirtualKeyCode`/`code` a key event needs.
 *
 * Chrome accepts a bare `key`, but a page listening on `keydown` and reading
 * `keyCode` — which is most of them — sees zeros without these. The map is
 * the few keys a browser agent actually presses; anything else goes through
 * with `key` alone and the page's own handler decides.
 */
function keyIdentity(key: string): { code?: string; windowsVirtualKeyCode?: number; text?: string } {
  const table: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Tab: { code: "Tab", vk: 9 },
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    Space: { code: "Space", vk: 32, text: " " },
  };
  const row = table[key];
  if (!row) return {};
  return { code: row.code, windowsVirtualKeyCode: row.vk, ...(row.text ? { text: row.text } : {}) };
}
