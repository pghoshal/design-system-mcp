import { LRUCache } from "lru-cache";

export interface CacheKeyContext {
  bundleVersion: string;
}

interface Slot {
  v: unknown;
}

/**
 * In-process LRU. Phase 1 keeps it minimal; Phase 2+ may layer per-tool TTLs.
 * Keys are namespaced by bundleVersion so a hot-rebuild implicitly invalidates.
 *
 * Values are wrapped in a Slot because lru-cache v11 requires a non-nullish
 * value type; the wrapper lets callers store primitives or undefined-able results.
 */
export class LayeredCache {
  readonly #lru: LRUCache<string, Slot>;

  constructor(opts?: { max?: number; ttlMs?: number }) {
    this.#lru = new LRUCache<string, Slot>({
      max: opts?.max ?? 1000,
      ttl: opts?.ttlMs ?? 5 * 60_000,
      ttlAutopurge: false,
    });
  }

  get<T>(ctx: CacheKeyContext, key: string): T | undefined {
    const slot = this.#lru.get(this.#k(ctx, key));
    return slot ? (slot.v as T) : undefined;
  }

  set<T>(ctx: CacheKeyContext, key: string, value: T, ttlMs?: number): void {
    const slot: Slot = { v: value };
    if (ttlMs !== undefined) {
      this.#lru.set(this.#k(ctx, key), slot, { ttl: ttlMs });
    } else {
      this.#lru.set(this.#k(ctx, key), slot);
    }
  }

  async fetchOrCompute<T>(
    ctx: CacheKeyContext,
    key: string,
    ttlMs: number,
    compute: () => Promise<T> | T,
  ): Promise<T> {
    const hit = this.get<T>(ctx, key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(ctx, key, value, ttlMs);
    return value;
  }

  #k(ctx: CacheKeyContext, key: string): string {
    return `${ctx.bundleVersion}:${key}`;
  }
}
