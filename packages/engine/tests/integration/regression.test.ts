/**
 * Decision Regression Corpus — the most critical test in the suite.
 *
 * Every entry is a CONTRACT: this exact (subject, action, object) must return
 * this exact decision — forever. Any refactor that silently flips an ALLOW to
 * DENY (or vice versa) breaks authorization semantics and is caught here
 * before it reaches production.
 *
 * The corpus covers:
 *   - Multi-hop ReBAC chains (3-hop: user → group → zone → shipment)
 *   - Role boundaries (viewer can read, cannot edit/delete)
 *   - Zone isolation (Chennai ↔ Mumbai, zero cross-access)
 *   - Direct ownership (admin_kumar has owner on both zones)
 *   - Hospital tenant: doctor vs nurse vs billing access levels
 *   - Unknown subject → DENY (not crash)
 *   - Non-existent object → NOT_FOUND (not ALLOW)
 *
 * DO NOT CHANGE the expected values without a deliberate policy review.
 * If a test fails, investigate whether the behavior change was intentional.
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

async function check(apiKey: string, subject: string, action: string, object: string) {
    const res = await app.inject({
        method: 'POST', url: '/v1/can',
        headers: { 'x-api-key': apiKey },
        payload: { subject, action, object },
    })
    return res.json<{ status: string; decision: string }>()
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

// ─── Logistics Tenant ────────────────────────────────────────────────────────
// BFS path: user:arjun → member → group:chennai_managers → owner → zone:chennai → viewer → shipment:TN001

describe('📦 Logistics — arjun (Chennai access via 3-hop chain)', () => {
    test('arjun can READ shipment:TN001 (viewer via zone:chennai)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:arjun', 'read', 'shipment:TN001')
        expect(r.status).toBe('ALLOW')
    })

    test('arjun can READ shipment:TN002 (same zone)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:arjun', 'read', 'shipment:TN002')
        expect(r.status).toBe('ALLOW')
    })

    test('arjun CANNOT EDIT shipment:TN001 (viewer does not grant edit)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:arjun', 'edit', 'shipment:TN001')
        expect(r.status).toBe('DENY')
    })

    test('arjun CANNOT DELETE shipment:TN001 (viewer does not grant delete)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:arjun', 'delete', 'shipment:TN001')
        expect(r.status).toBe('DENY')
    })

    test('arjun CANNOT READ shipment:MH001 (different zone, no cross-access)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:arjun', 'read', 'shipment:MH001')
        expect(r.status).toBe('DENY')
    })
})

describe('📦 Logistics — suresh (Mumbai-only access)', () => {
    test('suresh can READ shipment:MH001 (his zone)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:suresh', 'read', 'shipment:MH001')
        expect(r.status).toBe('ALLOW')
    })

    test('suresh CANNOT READ shipment:TN001 (Chennai zone, no path)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:suresh', 'read', 'shipment:TN001')
        expect(r.status).toBe('DENY')
    })

    test('suresh CANNOT READ shipment:TN002 (Chennai zone, no path)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:suresh', 'read', 'shipment:TN002')
        expect(r.status).toBe('DENY')
    })
})

describe('📦 Logistics — admin_kumar (owner on both zones)', () => {
    test('admin_kumar can READ shipment:TN001 (owner → zone:chennai → viewer → shipment)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:admin_kumar', 'read', 'shipment:TN001')
        expect(r.status).toBe('ALLOW')
    })

    test('admin_kumar can READ shipment:MH001 (owner → zone:mumbai → viewer → shipment)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:admin_kumar', 'read', 'shipment:MH001')
        expect(r.status).toBe('ALLOW')
    })

    // admin_kumar only has owner on the zone, not the shipment directly.
    // The shipment is reached via zone:chennai→viewer→shipment (viewer = read only).
    // So admin_kumar cannot edit/delete the shipment through this path.
    test('admin_kumar CANNOT EDIT shipment:TN001 (no editor/owner relation to shipment directly)', async () => {
        const r = await check(LOGISTICS_KEY, 'user:admin_kumar', 'edit', 'shipment:TN001')
        expect(r.status).toBe('DENY')
    })
})

describe('📦 Logistics — unknown subject', () => {
    test('user:nobody DENY for existing shipment', async () => {
        const r = await check(LOGISTICS_KEY, 'user:nobody', 'read', 'shipment:TN001')
        expect(r.status).toBe('DENY')
    })

    test('user:nobody on non-existent object → NOT_FOUND', async () => {
        const r = await check(LOGISTICS_KEY, 'user:nobody', 'read', 'shipment:GHOST')
        expect(r.status).toBe('NOT_FOUND')
    })
})

// ─── Hospital Tenant ─────────────────────────────────────────────────────────

describe('🏥 Hospital — dr_priya (doctor, owner of alice_record)', () => {
    test('dr_priya can READ patient:alice_record', async () => {
        const r = await check(HOSPITAL_KEY, 'user:dr_priya', 'read', 'patient:alice_record')
        expect(r.status).toBe('ALLOW')
    })

    test('dr_priya can EDIT patient:alice_record (owner via group:doctors)', async () => {
        const r = await check(HOSPITAL_KEY, 'user:dr_priya', 'edit', 'patient:alice_record')
        expect(r.status).toBe('ALLOW')
    })

    test('dr_priya can DELETE patient:alice_record (owner grants delete)', async () => {
        const r = await check(HOSPITAL_KEY, 'user:dr_priya', 'delete', 'patient:alice_record')
        expect(r.status).toBe('ALLOW')
    })

    test('dr_priya CANNOT access patient:alice_invoice (no path)', async () => {
        const r = await check(HOSPITAL_KEY, 'user:dr_priya', 'read', 'patient:alice_invoice')
        expect(r.status).toBe('DENY')
    })
})

describe('🏥 Hospital — nurse_raj (viewer of alice_record)', () => {
    test('nurse_raj can READ patient:alice_record', async () => {
        const r = await check(HOSPITAL_KEY, 'user:nurse_raj', 'read', 'patient:alice_record')
        expect(r.status).toBe('ALLOW')
    })

    test('nurse_raj CANNOT EDIT patient:alice_record (viewer does not grant edit)', async () => {
        const r = await check(HOSPITAL_KEY, 'user:nurse_raj', 'edit', 'patient:alice_record')
        expect(r.status).toBe('DENY')
    })

    test('nurse_raj CANNOT DELETE patient:alice_record', async () => {
        const r = await check(HOSPITAL_KEY, 'user:nurse_raj', 'delete', 'patient:alice_record')
        expect(r.status).toBe('DENY')
    })
})

describe('🏥 Hospital — billing_meena (viewer of invoice only)', () => {
    test('billing_meena can READ patient:alice_invoice', async () => {
        const r = await check(HOSPITAL_KEY, 'user:billing_meena', 'read', 'patient:alice_invoice')
        expect(r.status).toBe('ALLOW')
    })

    test('billing_meena CANNOT READ patient:alice_record (billing has no access to records)', async () => {
        const r = await check(HOSPITAL_KEY, 'user:billing_meena', 'read', 'patient:alice_record')
        expect(r.status).toBe('DENY')
    })
})
