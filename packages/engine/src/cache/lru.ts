/**
 * In-memory LRU cache for authorization decisions.
 *
 * Key format:  "{tenant_id}:{subject}:{object}:{action}"
 * Value:       { decision, lvn, suggestedFix? }
 *
 * THREE INDICES (each serves a different purpose):
 *
 * 1. tenantIndex   — Map<tenantId, Set<cacheKey>>
 *    Full tenant wipe. Kept as a fallback for bulk operations.
 *
 * 2. subjectIndex  — Map<"tenantId:entity", Set<cacheKey>>
 *    Tracks which cache entries had a given entity as the requesting subject.
 *    e.g. subjectIndex["t1:user:alice"] → all of alice's cached decisions.
 *
 * 3. objectIndex   — Map<"tenantId:entity", Set<cacheKey>>
 *    Tracks which cache entries had a given entity as the target resource.
 *    e.g. objectIndex["t1:invoice:5"] → all decisions about invoice:5.
 *
 * INDEX BLOAT FIX (dispose callback + keyMeta):
 *   The LRU auto-evicts entries silently when the cache hits its max size.
 *   Without cleanup, subjectIndex and objectIndex grow forever — one Map entry
 *   per unique entity ever seen, each containing a Set of keys that the LRU
 *   already deleted. After 1M unique subjects, the Maps hold 1M useless Sets.
 *
 *   Fix: register a `dispose` callback on the LRU. It fires on EVERY removal
 *   (auto-eviction, explicit delete, set() overwrite). The callback uses a
 *   `keyMeta` reverse map (cacheKey → { subjectKey, objectKey }) to find and
 *   remove the key from all three indices in O(1) time.
 *
 * WHY subjectIndex + objectIndex (Priority 2 fix — targeted invalidation):
 *   When tuple (user:carol, member, group:finance) is added, we only need to
 *   invalidate carol's cached decisions + decisions that targeted group:finance.
 *   Not all 10,000 entries for the entire tenant.
 *
 *   Before: add one tuple → delete 10,000 cache entries → DB hammered
 *   After:  add one tuple → delete ~3 cache entries → cache stays warm
 *
 * SUGGESTED FIX CACHING (Priority 3 fix):
 *   DENY results now store suggestedFix in the cache.
 *   On a cache-hit DENY, we return the stored suggestions instead of
 *   doing a reverse-lookup DB query on every retry.
 */
import { LRUCache } from 'lru-cache'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

export type CachedDecision = {
    decision: 'allow' | 'deny'
    lvn: number
    /**
     * Cached suggested fixes — only set for deny decisions.
     * Saves a DB reverse-lookup query on every repeated DENY.
     */
    suggestedFix?: string[]
}

/** Pass this when calling set() so the cache can build subject/object indices. */
export type CacheSetMeta = {
    subject: string
    object: string
}

class RuneCache {
    private readonly lru: LRUCache<string, CachedDecision>

    /** tenantId → Set of all cache keys for that tenant */
    private readonly tenantIndex = new Map<string, Set<string>>()

    /** "tenantId:entity" → Set of cache keys where entity is the requesting SUBJECT */
    private readonly subjectIndex = new Map<string, Set<string>>()

    /** "tenantId:entity" → Set of cache keys where entity is the target OBJECT */
    private readonly objectIndex = new Map<string, Set<string>>()

    /**
     * Reverse map: cacheKey → { subjectKey, objectKey }
     *
     * Used by the LRU dispose callback to locate and remove a key from the
     * subjectIndex and objectIndex in O(1) without scanning the entire Maps.
     * Also cleaned up by the dispose callback itself, so it never grows stale.
     */
    private readonly keyMeta = new Map<string, { subjectKey: string; objectKey: string }>()

    constructor() {
        this.lru = new LRUCache<string, CachedDecision>({
            max: config.cache.maxSize,
            updateAgeOnGet: true, // accessing an entry refreshes its LRU position

            /**
             * dispose fires on EVERY removal from the LRU:
             *   'evict'  — LRU silently evicted this entry because the cache is full
             *   'delete' — explicit cache.delete() or cache.deleteByChanged()
             *   'set'    — a new set() call overwrote this key
             *
             * By cleaning all three indices here, we guarantee the Maps never
             * accumulate stale entries from LRU auto-evictions.
             *
             * The explicit cleanup in delete() / deleteByChanged() / deleteByTenant()
             * becomes redundant for per-key operations but is kept as defence-in-depth
             * (idempotent — Set.delete() on a missing element is always a no-op).
             */
            dispose: (_value: CachedDecision, key: string) => {
                // Clean tenantIndex
                const tenantId = this.tenantFromKey(key)
                const tenantKeys = this.tenantIndex.get(tenantId)
                if (tenantKeys) {
                    tenantKeys.delete(key)
                    if (tenantKeys.size === 0) this.tenantIndex.delete(tenantId)
                }

                // Clean subjectIndex + objectIndex via reverse map — O(1)
                const meta = this.keyMeta.get(key)
                if (meta) {
                    const subjectKeys = this.subjectIndex.get(meta.subjectKey)
                    if (subjectKeys) {
                        subjectKeys.delete(key)
                        if (subjectKeys.size === 0) this.subjectIndex.delete(meta.subjectKey)
                    }
                    const objectKeys = this.objectIndex.get(meta.objectKey)
                    if (objectKeys) {
                        objectKeys.delete(key)
                        if (objectKeys.size === 0) this.objectIndex.delete(meta.objectKey)
                    }
                    this.keyMeta.delete(key)
                }
            },
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

    /** Build the lookup key used in subjectIndex / objectIndex. */
    private entityKey(tenantId: string, entity: string): string {
        return `${tenantId}:${entity}`
    }

    get(key: string): CachedDecision | undefined {
        return this.lru.get(key)
    }

    /**
     * Store a decision in the cache and register it in all three indices.
     *
     * @param key   - Cache key from buildKey()
     * @param value - The decision + LVN (+ optional suggestedFix for DENYs)
     * @param meta  - The subject and object of the can() call — used for targeted invalidation
     */
    set(key: string, value: CachedDecision, meta?: CacheSetMeta): void {
        // NOTE: if `key` already exists, lru.set() fires dispose for the OLD entry first,
        // cleaning up the OLD index registrations. We then re-register fresh ones below.
        this.lru.set(key, value)
        const tenantId = this.tenantFromKey(key)

        // Register in tenant index (for full-wipe fallback)
        this.addToIndex(this.tenantIndex, tenantId, key)

        // Register in subject and object indices (for targeted invalidation)
        // and store the reverse mapping so the dispose callback can clean them up.
        if (meta) {
            const subjectKey = this.entityKey(tenantId, meta.subject)
            const objectKey  = this.entityKey(tenantId, meta.object)
            this.addToIndex(this.subjectIndex, subjectKey, key)
            this.addToIndex(this.objectIndex, objectKey, key)
            this.keyMeta.set(key, { subjectKey, objectKey })
        }
    }

    /** Helper: add a cacheKey into a Map<string, Set<string>> index. */
    private addToIndex(index: Map<string, Set<string>>, indexKey: string, cacheKey: string): void {
        let keySet = index.get(indexKey)
        if (!keySet) {
            keySet = new Set()
            index.set(indexKey, keySet)
        }
        keySet.add(cacheKey)
    }

    /**
     * Delete a single key from the LRU and clean up the tenant index.
     */
    delete(key: string): void {
        this.lru.delete(key)
        const tenantId = this.tenantFromKey(key)
        const keySet = this.tenantIndex.get(tenantId)
        if (keySet) {
            keySet.delete(key)
            if (keySet.size === 0) this.tenantIndex.delete(tenantId)
        }
        // Note: we leave subject/object index entries pointing to the deleted key.
        // Those entries are harmless — deleteByChanged() checks lru.has() before deleting.
    }

    /**
     * TARGETED CACHE INVALIDATION — the Priority 2 fix.
     *
     * Call this instead of deleteByTenant() when a tuple changes.
     * Only wipes entries directly connected to the changed tuple.
     *
     * When tuple (changedSubject, relation, changedObject) changes, we invalidate:
     *   Case 1: entries where changedSubject was the requesting user
     *           → their access may have changed
     *   Case 2: entries where changedObject was the target resource
     *           → who can reach that resource may have changed
     *   Case 3: entries where changedSubject was the target resource
     *           → changedSubject might also appear as a resource in some decisions
     *   Case 4: entries where changedObject was the requesting user
     *           → changedObject might also be used as a requesting entity
     *
     * What we safely leave: deeply indirect paths two or more hops away.
     * The LVN/SCT mechanism handles those — a stale SCT forces a fresh BFS.
     *
     * Real impact example:
     *   Tenant has 10,000 cached decisions.
     *   Add user:carol to group:finance.
     *   Before this fix: delete all 10,000 entries.
     *   After this fix:  delete ~3 entries (carol's decisions + group:finance targets).
     */
    deleteByChanged(tenantId: string, changedSubject: string, changedObject: string): void {
        const keysToDelete = new Set<string>()

        const subjectKey1 = this.entityKey(tenantId, changedSubject)
        const objectKey2  = this.entityKey(tenantId, changedObject)
        const objectKey3  = this.entityKey(tenantId, changedSubject)
        const subjectKey4 = this.entityKey(tenantId, changedObject)

        this.subjectIndex.get(subjectKey1)?.forEach(k => keysToDelete.add(k))
        this.objectIndex.get(objectKey2)?.forEach(k  => keysToDelete.add(k))
        this.objectIndex.get(objectKey3)?.forEach(k  => keysToDelete.add(k))
        this.subjectIndex.get(subjectKey4)?.forEach(k => keysToDelete.add(k))

        let deleted = 0
        const tenantKeys = this.tenantIndex.get(tenantId)

        for (const key of keysToDelete) {
            if (this.lru.has(key)) {
                this.lru.delete(key)
                tenantKeys?.delete(key)
                deleted++
            }
        }

        // Clean up the now-stale index entries
        this.subjectIndex.delete(subjectKey1)
        this.objectIndex.delete(objectKey2)
        this.objectIndex.delete(objectKey3)
        this.subjectIndex.delete(subjectKey4)

        if (tenantKeys?.size === 0) this.tenantIndex.delete(tenantId)

        logger.debug({ tenantId, changedSubject, changedObject, deleted }, 'cache_targeted_invalidation')
    }

    /**
     * Wipe ALL cache entries for a tenant.
     * Kept as a fallback — normal tuple writes now use deleteByChanged().
     * Still used by: future schema changes, admin reset operations.
     */
    deleteByTenant(tenantId: string): void {
        const keySet = this.tenantIndex.get(tenantId)
        if (!keySet) return

        let deleted = 0
        for (const key of keySet) {
            this.lru.delete(key)
            deleted++
        }
        this.tenantIndex.delete(tenantId)

        // Clean up subject/object indices for this tenant
        const prefix = `${tenantId}:`
        for (const k of this.subjectIndex.keys()) {
            if (k.startsWith(prefix)) this.subjectIndex.delete(k)
        }
        for (const k of this.objectIndex.keys()) {
            if (k.startsWith(prefix)) this.objectIndex.delete(k)
        }

        logger.debug({ tenantId, deleted }, 'cache_tenant_wiped')
    }

    /**
     * Check if a cached entry is stale relative to the client's SCT LVN.
     *
     * Returns true  → entry is older than client's SCT → bypass cache, do fresh BFS
     * Returns true  → entry doesn't exist → bypass cache
     * Returns false → entry is fresh → serve from cache
     */
    isStale(key: string, requestLvn: number): boolean {
        const cached = this.lru.get(key)
        if (!cached) return true
        return cached.lvn < requestLvn
    }

    /** For metrics / debugging */
    getStats(): { size: number; maxSize: number; indexedKeys: number } {
        return {
            size: this.lru.size,
            maxSize: config.cache.maxSize,
            // keyMeta.size === number of entries currently tracked in subject/object indices.
            // Should always equal lru.size (minus entries set without meta, which never happens
            // in practice). If it grows much larger than lru.size, the dispose callback is not firing.
            indexedKeys: this.keyMeta.size,
        }
    }
}

// Singleton — one cache for the entire engine process
export const cache = new RuneCache()
