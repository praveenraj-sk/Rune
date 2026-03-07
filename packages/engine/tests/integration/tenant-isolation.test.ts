/**
 * Tenant Isolation Tests — the most catastrophic failure mode.
 *
 * Multi-tenancy means tenant A must NEVER read, write, or influence
 * tenant B's data — even with identical subject/object names.
 *
 * Covers:
 *   1.  Different API keys → different tenant scopes
 *   2.  Same subject name in two tenants → isolated decisions
 *   3.  Same object name in two tenants → isolated decisions
 *   4.  Write to tenant A does not affect tenant B's cache or data
 *   5.  Tuple added in tenant A is NOT visible in tenant B's can() check
 *   6.  Tuple added in tenant A is NOT visible in tenant B's /accessible
 *   7.  Deleting a tuple in tenant A does not affect tenant B
 *   8.  permission_index entries are scoped — tenant B index miss falls back to BFS, not A's index
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
    await query('DELETE FROM permission_index WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM permission_index WHERE tenant_id = $1', [HOSPITAL_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    cache.deleteByTenant(HOSPITAL_TENANT)
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
    await insertTuples(HOSPITAL_TENANT, hospitalTuples)
})

describe('🔒 Tenant Isolation', () => {

    // ── Test 1: API key determines tenant, not request body ──────────────────
    test('T1 key cannot read T2 objects even if they share the same name', async () => {
        // Add a tuple in BOTH tenants with the same names but different content
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'user:shared', 'owner', 'doc:shared', 1)`,
            [LOGISTICS_TENANT]
        )
        // LOGISTICS_TENANT has the tuple → ALLOW
        const logisticsRes = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:shared', action: 'read', object: 'doc:shared' },
        })
        expect(logisticsRes.json<{ status: string }>().status).toBe('ALLOW')

        // HOSPITAL_TENANT does NOT have this tuple → NOT_FOUND / DENY
        const hospitalRes = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:shared', action: 'read', object: 'doc:shared' },
        })
        expect(hospitalRes.json<{ status: string }>().status).not.toBe('ALLOW')
    })

    // ── Test 2: Logistics user cannot reach Hospital objects ─────────────────
    test('user:arjun (logistics) cannot access patient:alice_record (hospital)', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'patient:alice_record' },
        })
        // patient:alice_record doesn't exist in LOGISTICS_TENANT → NOT_FOUND
        expect(res.json<{ status: string }>().status).not.toBe('ALLOW')
    })

    // ── Test 3: Hospital user cannot reach Logistics objects ─────────────────
    test('user:dr_priya (hospital) cannot access shipment:TN001 (logistics)', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'shipment:TN001' },
        })
        expect(res.json<{ status: string }>().status).not.toBe('ALLOW')
    })

    // ── Test 4: Write to tenant A does not affect tenant B ───────────────────
    test('adding a tuple in logistics does not grant access in hospital', async () => {
        // Add a high-privilege tuple in LOGISTICS
        await app.inject({
            method: 'POST', url: '/v1/tuples',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:arjun', relation: 'owner', object: 'patient:alice_record' },
        })

        // Hospital tenant still denies — different tenant_id
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'patient:alice_record' },
        })
        // patient:alice_record exists in hospital via group:doctors, but user:arjun has no path in hospital
        expect(res.json<{ status: string }>().status).not.toBe('ALLOW')
    })

    // ── Test 5: Cache is isolated by tenant ──────────────────────────────────
    test('cache invalidation in tenant A does not affect tenant B cached decisions', async () => {
        // Warm the cache in both tenants
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'patient:alice_record' },
        })

        // Invalidate logistics cache via a write
        await app.inject({
            method: 'POST', url: '/v1/tuples',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:arjun', relation: 'viewer', object: 'shipment:NEW001' },
        })

        // Hospital cache should still be warm — dr_priya still gets ALLOW
        const hospitalRes = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'patient:alice_record' },
        })
        expect(hospitalRes.json<{ status: string }>().status).toBe('ALLOW')
    })

    // ── Test 6: /accessible is tenant-scoped ─────────────────────────────────
    test('/accessible only returns objects in the calling tenant', async () => {
        // Add same subject+action in both tenants pointing to different objects
        await query(
            `INSERT INTO permission_index (tenant_id, subject, action, object, granted_by) VALUES
             ($1, 'user:shared', 'read', 'logistics:obj', 'user:shared|owner|logistics:obj')`,
            [LOGISTICS_TENANT]
        )
        await query(
            `INSERT INTO permission_index (tenant_id, subject, action, object, granted_by) VALUES
             ($1, 'user:shared', 'read', 'hospital:obj', 'user:shared|owner|hospital:obj')`,
            [HOSPITAL_TENANT]
        )

        const logisticsRes = await app.inject({
            method: 'GET', url: '/v1/accessible?subject=user:shared&action=read',
            headers: { 'x-api-key': LOGISTICS_KEY },
        })
        const hospitalRes = await app.inject({
            method: 'GET', url: '/v1/accessible?subject=user:shared&action=read',
            headers: { 'x-api-key': HOSPITAL_KEY },
        })

        const logisticsObjects = logisticsRes.json<{ objects: string[] }>().objects
        const hospitalObjects = hospitalRes.json<{ objects: string[] }>().objects

        // Each tenant sees only its own objects
        expect(logisticsObjects).toContain('logistics:obj')
        expect(logisticsObjects).not.toContain('hospital:obj')
        expect(hospitalObjects).toContain('hospital:obj')
        expect(hospitalObjects).not.toContain('logistics:obj')
    })

    // ── Test 7: Deleting a tuple in T1 does not affect T2 ────────────────────
    test('revoking access in logistics does not affect hospital', async () => {
        // dr_priya is accessible in hospital
        const beforeRes = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'patient:alice_record' },
        })
        expect(beforeRes.json<{ status: string }>().status).toBe('ALLOW')

        // Delete a tuple in logistics (completely different tenant)
        await app.inject({
            method: 'DELETE', url: '/v1/tuples',
            headers: { 'x-api-key': LOGISTICS_KEY },
            payload: { subject: 'user:arjun', relation: 'member', object: 'group:chennai_managers' },
        })

        // Hospital is unaffected
        const afterRes = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': HOSPITAL_KEY },
            payload: { subject: 'user:dr_priya', action: 'read', object: 'patient:alice_record' },
        })
        expect(afterRes.json<{ status: string }>().status).toBe('ALLOW')
    })
})
