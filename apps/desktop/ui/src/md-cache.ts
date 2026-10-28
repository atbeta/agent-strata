type CacheEntry = { html: string; cost: number };

/**
 * Settled markdown, kept so a row that scrolls away and back does not parse
 * again. A long session is several megabytes of source plus the HTML it
 * became. A 2MB cap evicted that session mid-scroll, and the parse came back
 * as the hitch.
 */
export class MarkdownHtmlCache {
  private entries = new Map<string, CacheEntry>();
  private cost = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly maxCost = 16_000_000,
  ) {}

  get(source: string): string | undefined {
    const entry = this.entries.get(source);
    if (!entry) return undefined;
    this.entries.delete(source);
    this.entries.set(source, entry);
    return entry.html;
  }

  set(source: string, html: string): void {
    this.remove(source);
    const cost = source.length + html.length;
    if (this.maxEntries <= 0 || cost > this.maxCost) return;
    this.entries.set(source, { html, cost });
    this.cost += cost;
    while (this.entries.size > this.maxEntries || this.cost > this.maxCost) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get totalCost(): number {
    return this.cost;
  }

  private remove(source: string): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    this.entries.delete(source);
    this.cost -= entry.cost;
  }
}
