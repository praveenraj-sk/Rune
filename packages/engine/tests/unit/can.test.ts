/**
 * can() function integration tests.
 * Tests the full decision pipeline end-to-end.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { can } from '../../src/engine/can.js'
import { cache } from '../../src/cache/lru.js'
import { query } from '../../src/db/client.js'
import { refreshLvnFromDb } from '../../src/engine/lvn.js'
import { LOGISTICS_TENANT, EMPTY_TENANT, logisticsTuples, hospitalTuples, HOSPITAL_TENANT } from '../fixtures/tuples.js'

async function insertTuples(tenantId: string, tuples: Array<{ subject: string; relation: string; object: string }>) {
    for (const t of tuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
       VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [tenantId, t.subject, t.relation, t.object]
        )
    }
}

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM tuples WHERE tenant_id = $1', [HOSPITAL_TENANT])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    cache.deleteByTenant(HOSPITAL_TENANT)
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
    await insertTuples(HOSPITAL_TENANT, hospitalTuples)
    // Sync in-memory LVN from DB so sct.lvn reflects real sequence value
    await refreshLvnFromDb()
})

afterEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM tuples WHERE tenant_id = $1', [HOSPITAL_TENANT])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    cache.deleteByTenant(HOSPITAL_TENANT)
})

describe('can() function', () => {

    test('ALLOW: arjun can read TN001 shipment via zone membership', async () => {
        const result = await can({
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
            tenantId: LOGISTICS_TENANT,
        })
        expect(result.status).toBe('ALLOW')
        expect(result.decision).toBe('allow')
        expect(result.trace.length).toBeGreaterThan(0)
        expect(result.cache_hit).toBe(false)
        expect(result.latency_ms).toBeGreaterThan(0)
        expect(result.sct.lvn).toBeGreaterThan(0)
    })

    test('DENY: arjun cannot read Mumbai shipment — returns suggested_fix', async () => {
        const result = await can({
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:MH001',
            tenantId: LOGISTICS_TENANT,
        })
        expect(result.status).toBe('DENY')
        expect(result.suggested_fix.length).toBeGreaterThan(0)
        expect(result.reason).toBeTruthy()
    })

    test('CACHE HIT: second call returns cache_hit=true with sub-1ms latency', async () => {
        await can({ subject: 'user:arjun', action: 'read', object: 'shipment:TN001', tenantId: LOGISTICS_TENANT })
        const result = await can({ subject: 'user:arjun', action: 'read', object: 'shipment:TN001', tenantId: LOGISTICS_TENANT })
        expect(result.cache_hit).toBe(true)
        expect(result.latency_ms).toBeLessThan(10)
    })

    test('NOT_FOUND: nonexistent object returns NOT_FOUND status', async () => {
        const result = await can({
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:GHOST',
            tenantId: LOGISTICS_TENANT,
        })
        expect(result.status).toBe('NOT_FOUND')
        expect(result.decision).toBe('deny')
    })

    test('FAIL CLOSED: empty subject returns DENY', async () => {
        const result = await can({ subject: '', action: 'read', object: 'shipment:TN001', tenantId: LOGISTICS_TENANT })
        expect(result.status).toBe('DENY')
        expect(result.decision).toBe('deny')
    })

    test('TENANT ISOLATION: arjun in T1 cannot access T2 resources', async () => {
        // arjun exists in LOGISTICS_TENANT only
        const result = await can({
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
            tenantId: EMPTY_TENANT,  // different tenant — no data
        })
        expect(result.status).toBe('NOT_FOUND')
        expect(result.decision).toBe('deny')
    })

    test('SCT: bypasses cache when client LVN is higher than cached LVN', async () => {
        // Prime the cache with a stale entry at lvn=1
        const key = cache.buildKey(LOGISTICS_TENANT, 'user:arjun', 'shipment:TN001', 'read')
        cache.set(key, { decision: 'deny', lvn: 1 })

        // Request with sct.lvn=9999 (higher than cached) — must bypass cache
        const result = await can({
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
            tenantId: LOGISTICS_TENANT,
            sct: { lvn: 9999 },
        })
        expect(result.cache_hit).toBe(false)
        // After bypassing stale cache, BFS runs and finds the correct answer
        expect(result.status).toBe('ALLOW')
    })

})
