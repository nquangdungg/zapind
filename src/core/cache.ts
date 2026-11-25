interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded LRU-like TTL cache to avoid redundant network requests and prevent unbounded memory growth.
 */
export class TTLCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(options: { maxEntries?: number; defaultTtlMs?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
    this.defaultTtlMs = Math.max(1, options.defaultTtlMs ?? 60_000);
  }

  public get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  public set(key: K, value: V, ttlMs = this.defaultTtlMs): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: K): boolean {
    return this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public get size(): number {
    return this.store.size;
  }
}

/**
 * Deduplicates concurrent identical async calls so parallel callers share one network request.
 */
export class InFlightDeduplicator {
  private readonly pending = new Map<string, Promise<unknown>>();

  public run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = fn().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  public clear(): void {
    this.pending.clear();
  }
}
