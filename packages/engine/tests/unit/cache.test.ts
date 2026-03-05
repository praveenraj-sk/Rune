/**
 * LRU Cache unit tests.
 * These are pure in-memory tests — no DB needed.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { cache } from '../../src/cache/lru.js'

const T1 = '11111111-1111-1111-1111-111111111111'
const T2 = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
    // Start each test with a clean slate for both tenants
    cache.deleteByTenant(T1)
    cache.deleteByTenant(T2)
})

describe('SAECache', () => {
    test('stores and retrieves a decision', () => {
        const key = cache.buildKey(T1, 'user:arjun', 'shipment:TN001', 'read')
        cache.set(key, { decision: 'allow', lvn: 100 })
        expect(cache.get(key)?.decision).toBe('allow')
        expect(cache.get(key)?.lvn).toBe(100)
    })

    test('returns undefined for missing key', () => {
        const key = cache.buildKey(T1, 'user:nobody', 'shipment:X', 'read')
        expect(cache.get(key)).toBeUndefined()
    })

    test('deleteByTenant removes only that tenant — other tenant untouched', () => {
        const k1 = cache.buildKey(T1, 'user:arjun', 'shipment:TN001', 'read')
        const k2 = cache.buildKey(T1, 'user:suresh', 'shipment:TN002', 'read')
        const k3 = cache.buildKey(T2, 'user:other', 'shipment:MH001', 'read')

        cache.set(k1, { decision: 'allow', lvn: 1 })
        cache.set(k2, { decision: 'deny', lvn: 1 })
        cache.set(k3, { decision: 'allow', lvn: 1 })

        cache.deleteByTenant(T1)

        expect(cache.get(k1)).toBeUndefined()  // T1 wiped
        expect(cache.get(k2)).toBeUndefined()  // T1 wiped
        expect(cache.get(k3)).toBeDefined()    // T2 untouched
    })

    test('isStale: returns true when cached lvn < requestLvn', () => {
        const key = cache.buildKey(T1, 'user:arjun', 'shipment:TN001', 'read')
        cache.set(key, { decision: 'allow', lvn: 50 })

        expect(cache.isStale(key, 100)).toBe(true)  // newer LVN → stale
        expect(cache.isStale(key, 50)).toBe(false)  // same LVN → fresh
        expect(cache.isStale(key, 30)).toBe(false)  // older LVN → still fresh
    })

    test('isStale: returns true for nonexistent key', () => {
        expect(cache.isStale('nonexistent:key', 1)).toBe(true)
    })

    test('buildKey produces correct format', () => {
        const key = cache.buildKey('t1', 'user:1', 'invoice:5', 'read')
        expect(key).toBe('t1:user:1:invoice:5:read')
    })

    test('getStats returns current size', () => {
        const key = cache.buildKey(T1, 'user:arjun', 'shipment:TN001', 'read')
        cache.set(key, { decision: 'allow', lvn: 1 })
        const stats = cache.getStats()
        expect(stats.size).toBeGreaterThan(0)
        expect(stats.maxSize).toBe(10000)
    })

    test('deleteByTenant removes all keys via index — other tenant untouched', () => {
        const k1 = cache.buildKey(T1, 'user:arjun', 'shipment:TN001', 'read')
        const k2 = cache.buildKey(T1, 'user:suresh', 'shipment:TN002', 'edit')
        const k3 = cache.buildKey(T2, 'user:other', 'shipment:MH001', 'read')

        cache.set(k1, { decision: 'allow', lvn: 1 })
        cache.set(k2, { decision: 'deny', lvn: 1 })
        cache.set(k3, { decision: 'allow', lvn: 1 })

        cache.deleteByTenant(T1)

        expect(cache.get(k1)).toBeUndefined()   // T1 wiped
        expect(cache.get(k2)).toBeUndefined()   // T1 wiped
        expect(cache.get(k3)).toBeDefined()     // T2 untouched
    })

    test('deleteByTenant is a no-op for an unknown tenant', () => {
        // Should not throw
        expect(() => cache.deleteByTenant('unknown-tenant')).not.toThrow()
    })

    test('delete() removes a single key and cleans up the tenant index', () => {
        const k1 = cache.buildKey(T1, 'user:arjun', 'doc:readme', 'read')
        const k2 = cache.buildKey(T1, 'user:arjun', 'doc:readme', 'edit')

        cache.set(k1, { decision: 'allow', lvn: 1 })
        cache.set(k2, { decision: 'deny', lvn: 1 })

        cache.delete(k1)
        expect(cache.get(k1)).toBeUndefined()  // deleted
        expect(cache.get(k2)).toBeDefined()    // sibling untouched

        // Delete last key for T1 — index Set should be removed entirely
        cache.delete(k2)
        expect(cache.get(k2)).toBeUndefined()
        // deleteByTenant on now-empty tenant should still be a no-op
        expect(() => cache.deleteByTenant(T1)).not.toThrow()
    })
})
