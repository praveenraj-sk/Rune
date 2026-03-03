/**
 * In-memory LRU cache for authorization decisions.
 *
 * Key format:  "{tenant_id}:{subject}:{object}:{action}"
 * Value:       { decision: 'allow' | 'deny', lvn: number }
 *
 * Design decisions:
 * - LRU eviction so hot paths stay warm automatically
 * - Tenant-scoped wipe on every write (brute force but safe at Phase 1 scale)
 * - LVN comparison for SCT-based staleness detection
 */
import { LRUCache } from 'lru-cache'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

export type CachedDecision = {
    decision: 'allow' | 'deny'
    lvn: number
}

class RuneCache {
    private readonly lru: LRUCache<string, CachedDecision>

    constructor() {
        this.lru = new LRUCache<string, CachedDecision>({
            max: config.cache.maxSize,
            updateAgeOnGet: true, // accessing an entry refreshes its LRU position
        })
        logger.info({ maxSize: config.cache.maxSize }, 'cache_initialized')
    }

    /**
     * Build a cache key from the four components of a can() call.
     * All four must be present — missing any one = different cache entry.
     */
    buildKey(tenantId: string, subject: string, object: string, action: string): string {
        return `${tenantId}:${subject}:${object}:${action}`
    }

    get(key: string): CachedDecision | undefined {
        return this.lru.get(key)
    }

    set(key: string, value: CachedDecision): void {
        this.lru.set(key, value)
    }

    /**
     * Wipe ALL cache entries belonging to a tenant.
     *
     * Called on every POST/DELETE /tuples for that tenant.
     * This is brute-force O(n) but correct.
     * At Phase 1 scale (<1M req/day), this runs rarely enough to be fine.
     * Phase 2 will replace this with subscription-based scoped invalidation.
     */
    deleteByTenant(tenantId: string): void {
        const prefix = `${tenantId}:`
        let deleted = 0
        for (const key of this.lru.keys()) {
            if (key.startsWith(prefix)) {
                this.lru.delete(key)
                deleted++
            }
        }
        logger.debug({ tenantId, deleted }, 'cache_tenant_wiped')
    }

    /**
     * Check if a cached entry is stale relative to the client's SCT LVN.
     *
     * Returns true  → cached entry is older than client's known LVN → bypass cache
     * Returns true  → entry doesn't exist → bypass cache
     * Returns false → cached entry is fresh enough → serve from cache
     */
    isStale(key: string, requestLvn: number): boolean {
        const cached = this.lru.get(key)
        if (!cached) return true
        return cached.lvn < requestLvn
    }

    /** For metrics / debugging */
    getStats(): { size: number; maxSize: number } {
        return { size: this.lru.size, maxSize: config.cache.maxSize }
    }
}

// Singleton — one cache for the entire engine process
export const cache = new RuneCache()
