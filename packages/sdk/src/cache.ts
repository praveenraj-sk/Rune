/**
 * SDK-side LRU cache for permission decisions.
 *
 * Caches ALLOW/DENY results locally to avoid redundant HTTP calls.
 * Uses TTL (time-to-live) so cached results expire automatically.
 * Uses the SCT (Stale Cache Token / LVN) from the engine to
 * invalidate stale entries when relationships change.
 *
 * Zero dependencies — plain Map-based LRU.
 */

type CachedDecision = {
    permission: CacheablePermission
    expiresAt: number   // Date.now() + ttl
    lvn: number         // logical version number at cache time
}

/** Subset of Permission that we cache (no need to cache latency_ms etc.) */
export type CacheablePermission = {
    decision: 'allow' | 'deny'
    status: string
    reason: string
}

export type LocalCacheOptions = {
    /** Max number of entries. Default: 1000 */
    maxSize?: number
    /** Time-to-live in ms. Default: 30000 (30s) */
    ttl?: number
}

export class LocalCache {
    private readonly cache = new Map<string, CachedDecision>()
    private readonly maxSize: number
    private readonly ttl: number

    constructor(options: LocalCacheOptions = {}) {
        this.maxSize = options.maxSize ?? 1000
        this.ttl = options.ttl ?? 30_000
    }

    /** Build a cache key from the check params */
    static buildKey(subject: string, action: string, object: string): string {
        return `${subject}|${action}|${object}`
    }

    /** Get a cached decision if it exists and is still valid */
    get(key: string, currentLvn?: number): CacheablePermission | null {
        const entry = this.cache.get(key)
        if (!entry) return null

        // Expired?
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key)
            return null
        }

        // Stale via SCT? (if caller provides a newer LVN, cache is stale)
        if (currentLvn !== undefined && currentLvn > entry.lvn) {
            this.cache.delete(key)
            return null
        }

        // Move to end (most recently used) — Map preserves insertion order
        this.cache.delete(key)
        this.cache.set(key, entry)

        return entry.permission
    }

    /** Store a decision in the cache */
    set(key: string, permission: CacheablePermission, lvn: number): void {
        // If at capacity, remove the oldest entry (first in Map)
        if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value
            if (oldest !== undefined) {
                this.cache.delete(oldest)
            }
        }

        this.cache.set(key, {
            permission,
            expiresAt: Date.now() + this.ttl,
            lvn,
        })
    }

    /** Clear all cached entries */
    clear(): void {
        this.cache.clear()
    }

    /** Number of entries currently cached */
    get size(): number {
        return this.cache.size
    }
}
