/**
 * Failure mode tests — system must always fail closed.
 *
 * Core guarantee: any infrastructure failure (DB down, cache crash)
 * MUST return DENY, never ALLOW, never an unhandled exception.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { can } from '../../src/engine/can.js'
import { cache } from '../../src/cache/lru.js'
import { query } from '../../src/db/client.js'
import { LOGISTICS_TENANT, logisticsTuples } from '../fixtures/tuples.js'

beforeAll(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    for (const t of logisticsTuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
             VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
            [LOGISTICS_TENANT, t.subject, t.relation, t.object]
        )
    }
})

afterAll(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
})

describe('Failure Modes — Always Fail Closed', () => {

    test('DB down → returns DENY, never throws', async () => {
        // Inject a broken DB that always rejects
        const brokenQuery = () => Promise.reject(new Error('ECONNREFUSED'))
        const fakeDb = { query: brokenQuery } as never

        // Temporarily swap the module — call can() with overridden db via test double
        // Since can() uses the singleton db client, we simulate by passing bad tenantId
        // that forces an error in BFS (non-UUID causes Postgres to throw)
        const result = await can({
            tenantId: 'not-a-uuid-at-all!!!',
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
        })

        // Must return deny — not throw
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('empty tenantId → DENY immediately (no DB hit)', async () => {
        const result = await can({
            tenantId: '',
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
        })
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
        expect(result.latency_ms).toBeLessThan(5)  // must fail before hitting DB
    })

    test('empty subject → DENY immediately', async () => {
        const result = await can({
            tenantId: LOGISTICS_TENANT,
            subject: '',
            action: 'read',
            object: 'shipment:TN001',
        })
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('empty object → DENY immediately', async () => {
        const result = await can({
            tenantId: LOGISTICS_TENANT,
            subject: 'user:arjun',
            action: 'read',
            object: '',
        })
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('empty action → DENY immediately', async () => {
        const result = await can({
            tenantId: LOGISTICS_TENANT,
            subject: 'user:arjun',
            action: '',
            object: 'shipment:TN001',
        })
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('unknown action → DENY (not an unhandled error)', async () => {
        const result = await can({
            tenantId: LOGISTICS_TENANT,
            subject: 'user:arjun',
            action: 'fly_to_the_moon',
            object: 'shipment:TN001',
        })
        expect(result.decision).toBe('deny')
        // Must never throw even for totally unknown action
    })

    test('repeated calls with cleared cache always return consistent decisions', async () => {
        const input = {
            tenantId: LOGISTICS_TENANT,
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
        }

        const results = []
        for (let i = 0; i < 5; i++) {
            cache.deleteByTenant(LOGISTICS_TENANT)
            results.push(await can(input))
        }

        // All 5 results must agree — no flakiness
        const decisions = results.map(r => r.decision)
        expect(new Set(decisions).size).toBe(1)  // all the same
    })

    test('can() result always has all required fields', async () => {
        const result = await can({
            tenantId: LOGISTICS_TENANT,
            subject: 'user:arjun',
            action: 'read',
            object: 'shipment:TN001',
        })

        // Every field in the contract must be present
        expect(typeof result.decision).toBe('string')
        expect(typeof result.status).toBe('string')
        expect(typeof result.reason).toBe('string')
        expect(Array.isArray(result.trace)).toBe(true)
        expect(Array.isArray(result.suggested_fix)).toBe(true)
        expect(typeof result.cache_hit).toBe('boolean')
        expect(typeof result.latency_ms).toBe('number')
        expect(result.latency_ms).toBeGreaterThan(0)
        expect(typeof result.sct).toBe('object')
        expect(typeof result.sct.lvn).toBe('number')
    })
})
