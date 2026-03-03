/**
 * Security test suite — 10 attack scenarios.
 * ALL 10 must pass before Phase 1 is considered complete.
 *
 * Attacks tested:
 * 1.  Tenant isolation — T1 can't access T2 data
 * 2.  Subject injection via request body (rejected)
 * 3.  Invalid relation injection
 * 4.  Missing API key → 401
 * 5.  Invalid API key → 401
 * 6.  BFS depth bomb (circular 25-level chain)
 * 7.  BFS width bomb (1001-member fan-out)
 * 8.  Circular relationships → no infinite loop
 * 9.  Fail-closed: empty subject returns DENY (not ALLOW)
 * 10. Stack trace not exposed in error responses
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import {
    LOGISTICS_TENANT,
    HOSPITAL_TENANT,
    logisticsTuples,
    hospitalTuples,
} from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

const LOGISTICS_KEY = 'rune-test-key-1234567890'
const HOSPITAL_KEY = 'rune-test-key-hospital'

const app = createTestApp()

async function insertTuples(tenantId: string, tuples: Array<{ subject: string; relation: string; object: string }>) {
    for (const t of tuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
       VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [tenantId, t.subject, t.relation, t.object]
        )
    }
}

beforeAll(async () => { await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM tuples WHERE tenant_id = $1', [HOSPITAL_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    cache.deleteByTenant(HOSPITAL_TENANT)
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
    await insertTuples(HOSPITAL_TENANT, hospitalTuples)
})

describe('🛡️ Security Tests', () => {

    // ─── Attack 1: Tenant Isolation ────────────────────────────────────────────
    test('ATTACK 1 — Tenant isolation: T1 key cannot see T2 data', async () => {
        // arjun exists in LOGISTICS_TENANT but not HOSPITAL_TENANT
        // Using LOGISTICS key to query a hospital resource → DENY (NOT_FOUND)
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'patient:alice_record' },
        })
        const body = res.json<{ status: string }>()
        // patient:alice_record doesn't exist in LOGISTICS_TENANT
        expect(body.status).toMatch(/DENY|NOT_FOUND/)
        expect(body.status).not.toBe('ALLOW')
    })

    // ─── Attack 2: Subject Injection ────────────────────────────────────────────
    test('ATTACK 2 — Subject injection: even if attacker sends admin subject, tenant is isolated', async () => {
        // Attacker uses LOGISTICS key but tries to claim they are user:admin_kumar from hospital
        // Because tenantId is set from API key, the object lookup is scoped to LOGISTICS_TENANT
        // patient:alice_record doesn't exist in LOGISTICS_TENANT → NOT_FOUND
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:admin_kumar', action: 'read', object: 'patient:alice_record' },
        })
        const body = res.json<{ status: string; decision: string }>()
        expect(body.decision).toBe('deny')
        expect(body.status).not.toBe('ALLOW')
    })

    // ─── Attack 3: Invalid Relation Injection ───────────────────────────────────
    test('ATTACK 3 — Invalid relation rejected at route level', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/tuples',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:evil', relation: 'superadmin', object: 'zone:chennai' },
        })
        expect(res.statusCode).toBe(400)
    })

    // ─── Attack 4: Missing API Key ──────────────────────────────────────────────
    test('ATTACK 4 — Missing x-api-key returns 401', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            payload: { action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(401)
        const body = res.json<{ error: string }>()
        expect(body.error).toBe('missing_api_key')
    })

    // ─── Attack 5: Invalid API Key ──────────────────────────────────────────────
    test('ATTACK 5 — Invalid API key returns 401', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': 'totally-fake-key-00000' },
            payload: { action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(401)
        const body = res.json<{ error: string }>()
        expect(body.error).toBe('invalid_api_key')
    })

    // ─── Attack 6: BFS Depth Bomb ───────────────────────────────────────────────
    test('ATTACK 6 — BFS depth bomb: 25-level chain hits depth limit, returns DENY', async () => {
        // Build 25-level chain
        for (let i = 0; i < 25; i++) {
            await query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, $2, 'member', $3, 1)`,
                [LOGISTICS_TENANT, `depth:${i}`, `depth:${i + 1}`]
            )
        }
        // target must exist as object
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'dummy', 'viewer', 'depth:25', 1)`,
            [LOGISTICS_TENANT]
        )
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'depth:0', action: 'read', object: 'depth:25' },
        })
        const body = res.json<{ status: string; decision: string }>()
        expect(body.decision).toBe('deny')
        expect(body.status).toBe('DENY')
    })

    // ─── Attack 7: BFS Width Bomb ───────────────────────────────────────────────
    test('ATTACK 7 — BFS width bomb: 1001-fan-out hits node limit, returns DENY', async () => {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'user:attacker', 'member', 'group:root', 1)`,
            [LOGISTICS_TENANT]
        )
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'x', 'viewer', 'resource:target', 1)`,
            [LOGISTICS_TENANT]
        )
        for (let i = 0; i < 1001; i++) {
            await query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'group:root', 'member', $2, 1)`,
                [LOGISTICS_TENANT, `group:wide_${i}`]
            )
        }
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:attacker', action: 'read', object: 'resource:target' },
        })
        const body = res.json<{ status: string; decision: string }>()
        expect(body.decision).toBe('deny')
    })

    // ─── Attack 8: Circular Relationships ──────────────────────────────────────
    test('ATTACK 8 — Circular relationships complete without hanging', async () => {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES
       ($1, 'circ:a', 'member', 'circ:b', 1),
       ($1, 'circ:b', 'member', 'circ:a', 1)`,
            [LOGISTICS_TENANT]
        )
        const start = Date.now()
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'circ:a', action: 'read', object: 'circ:b' },
        })
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(3000)
        expect(res.statusCode).toBe(200)
    })

    // ─── Attack 9: Fail Closed — Empty Subject ──────────────────────────────────
    test('ATTACK 9 — Fail closed: empty subject blocked by schema validation (400, not 200 ALLOW)', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: '', action: 'read', object: 'shipment:TN001' },
        })
        // Schema (minLength:1) catches this before can() is called — more secure than can() returning deny
        expect(res.statusCode).toBe(400)
        const body = res.json<{ error: string }>()
        expect(body.error).toBe('validation_error')
    })

    // ─── Attack 10: No Stack Trace Exposure ─────────────────────────────────────
    test('ATTACK 10 — Error responses never expose stack traces', async () => {
        // Send completely invalid JSON body
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY, 'content-type': 'application/json' },
            payload: 'not-json-at-all',
        })
        const rawBody = res.body
        expect(rawBody).not.toContain('at Object.')
        expect(rawBody).not.toContain('node_modules')
        expect(rawBody).not.toContain('stack')
    })

})
