/**
 * In-memory LRU cache for authorization decisions.
 *
 * Key format:  "{tenant_id}:{subject}:{object}:{action}"
 * Value:       { decision: 'allow' | 'deny', lvn: number }
 *
 * Design decisions:
 * - LRU eviction so hot paths stay warm automatically
 * - Tenant index (Map<tenantId, Set<key>>) makes deleteByTenant O(k) not O(n)
 * - Empty Sets are removed from the index after a full tenant wipe or single-key delete
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
    /** tenantId → Set of cache keys belonging to that tenant */
    private readonly tenantIndex = new Map<string, Set<string>>()

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

    /** Extract the tenantId prefix from a cache key (first colon-delimited segment). */
    private tenantFromKey(key: string): string {
        return key.substring(0, key.indexOf(':'))
    }

    get(key: string): CachedDecision | undefined {
        return this.lru.get(key)
    }

    set(key: string, value: CachedDecision): void {
        this.lru.set(key, value)
        // Register key in the tenant index
        const tenantId = this.tenantFromKey(key)
        let keySet = this.tenantIndex.get(tenantId)
        if (!keySet) {
            keySet = new Set()
            this.tenantIndex.set(tenantId, keySet)
        }
        keySet.add(key)
    }

    /**
     * Delete a single key and remove it from the tenant index.
     * Cleans up the tenant Set if it becomes empty.
     */
    delete(key: string): void {
        this.lru.delete(key)
        const tenantId = this.tenantFromKey(key)
        const keySet = this.tenantIndex.get(tenantId)
        if (keySet) {
            keySet.delete(key)
            if (keySet.size === 0) this.tenantIndex.delete(tenantId)
        }
    }

    /**
     * Wipe ALL cache entries belonging to a tenant — O(k) where k = entries for that tenant.
     *
     * Uses the tenant index instead of scanning all LRU keys.
     * Called on every POST/DELETE /tuples for that tenant.
     * Phase 2 will replace this with subscription-based scoped invalidation.
     */
    deleteByTenant(tenantId: string): void {
        const keySet = this.tenantIndex.get(tenantId)
        if (!keySet) return

        let deleted = 0
        for (const key of keySet) {
            this.lru.delete(key)
            deleted++
        }
        // Remove the now-empty Set from the index
        this.tenantIndex.delete(tenantId)
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
