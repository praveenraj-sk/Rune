/**
 * BFS Traversal tests — the most critical test suite.
 * ALL 8 tests must pass before moving to STEP 7.
 *
 * Uses the Chennai logistics scenario + hospital scenario.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { traverse } from '../../src/bfs/traverse.js'
import { query } from '../../src/db/client.js'
import { LOGISTICS_TENANT, HOSPITAL_TENANT, logisticsTuples, hospitalTuples } from '../fixtures/tuples.js'

// Helper: insert tuples for a given tenant
async function insertTuples(tenantId: string, tuples: Array<{ subject: string; relation: string; object: string }>) {
    for (const t of tuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT DO NOTHING`,
            [tenantId, t.subject, t.relation, t.object]
        )
    }
}

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM tuples WHERE tenant_id = $1', [HOSPITAL_TENANT])
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
    await insertTuples(HOSPITAL_TENANT, hospitalTuples)
})

afterEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    await query('DELETE FROM tuples WHERE tenant_id = $1', [HOSPITAL_TENANT])
})

describe('BFS Traversal', () => {

    test('ALLOW: finds path through 3-hop zone membership (arjun → group → zone → shipment)', async () => {
        const result = await traverse(LOGISTICS_TENANT, 'user:arjun', 'shipment:TN001', 'read')
        expect(result.found).toBe(true)
        expect(result.objectExists).toBe(true)
        expect(result.path).toContain('group:chennai_managers')
        expect(result.path).toContain('zone:chennai')
        expect(result.limitHit).toBeNull()
    })

    test('DENY: arjun cannot access Mumbai shipment (zone isolation)', async () => {
        const result = await traverse(LOGISTICS_TENANT, 'user:arjun', 'shipment:MH001', 'read')
        expect(result.found).toBe(false)
        expect(result.objectExists).toBe(true)
        expect(result.limitHit).toBeNull()
    })

    test('ALLOW: direct ownership — admin_kumar can manage anything', async () => {
        const result = await traverse(LOGISTICS_TENANT, 'user:admin_kumar', 'zone:chennai', 'manage')
        expect(result.found).toBe(true)
    })

    test('DENY: viewer cannot edit', async () => {
        // nurse_raj is viewer of patient:alice_record — cannot edit
        const result = await traverse(HOSPITAL_TENANT, 'user:nurse_raj', 'patient:alice_record', 'edit')
        expect(result.found).toBe(false)
        expect(result.objectExists).toBe(true)
    })

    test('NOT_FOUND: target object has no tuples at all', async () => {
        const result = await traverse(LOGISTICS_TENANT, 'user:arjun', 'shipment:GHOST999', 'read')
        expect(result.found).toBe(false)
        expect(result.objectExists).toBe(false)
    })

    test('CIRCULAR: handles circular relationships without hanging', async () => {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES
       ($1, 'group:a', 'member', 'group:b', 1),
       ($1, 'group:b', 'member', 'group:a', 1)`,
            [LOGISTICS_TENANT]
        )
        const start = Date.now()
        const result = await traverse(LOGISTICS_TENANT, 'user:arjun', 'group:a', 'read')
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(3000)  // must complete, not hang
        expect(result.limitHit).toBeNull()  // circular, but small — should not hit limits
        expect(result).toBeDefined()
    })

    test('LIMIT DEPTH: stops at MAX_BFS_DEPTH and returns limitHit: depth', async () => {
        // Build a 25-level deep chain: node:0 → node:1 → ... → node:24
        for (let i = 0; i < 25; i++) {
            await query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, $2, 'member', $3, 1)`,
                [LOGISTICS_TENANT, `chain:${i}`, `chain:${i + 1}`]
            )
        }
        // chain:25 is the target object — insert it as an object so existence check passes
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'dummy:x', 'viewer', 'chain:25', 1)`,
            [LOGISTICS_TENANT]
        )
        const result = await traverse(LOGISTICS_TENANT, 'chain:0', 'chain:25', 'read')
        expect(result.limitHit).toBe('depth')
        expect(result.found).toBe(false)
    })

    test('LIMIT NODES: stops at MAX_BFS_NODES and returns limitHit: nodes', async () => {
        // Create target resource so existence check passes
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'dummy:x', 'viewer', 'resource:target', 1)`,
            [LOGISTICS_TENANT]
        )
        // group:root fans out to 1001 sub-nodes — each is a separate group
        // BFS from user:flood_start will visit group:root then expand 1001 children
        // hitting MAX_BFS_NODES (1000) before finding the target
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, 'user:flood_start', 'member', 'group:root', 1)`,
            [LOGISTICS_TENANT]
        )
        for (let i = 0; i < 1001; i++) {
            await query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn) VALUES ($1, $2, 'member', $3, 1)`,
                [LOGISTICS_TENANT, 'group:root', `group:wide_${i}`]
            )
        }
        const result = await traverse(LOGISTICS_TENANT, 'user:flood_start', 'resource:target', 'read')
        expect(result.limitHit).toBe('nodes')
        expect(result.found).toBe(false)
    })

})
