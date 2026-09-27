/**
 * A Map with a TTL and a size ceiling.
 *
 * The caches this replaces checked expiry on read but never removed anything,
 * so they grew to whatever the catalog happened to contain and stayed there
 * for the lifetime of the process. On a 24/7 bot that is an unbounded,
 * invisible leak: nothing ever reports a high-water mark and nothing evicts.
 *
 * Eviction runs on write, expired entries first and then the oldest ones, so a
 * single expensive sweep is amortised across inserts instead of needing a timer.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** The cached value if present and still fresh, otherwise undefined. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-insert so Map iteration order stays oldest-first for eviction.
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    if (this.entries.size > this.maxEntries) this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drop expired entries, then the oldest ones until back under the ceiling. */
  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
    // Map iterates in insertion order, so the first keys are the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
