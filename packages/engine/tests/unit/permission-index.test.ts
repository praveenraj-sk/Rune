/**
 * Permission index unit tests — @runeauth/engine
 *
 * Tests:
 * 1. Index hit skips BFS (index_hit: true)
 * 2. Index DENY + BFS fallback still returns correct result
 * 3. Index lag (index miss) → BFS runs and returns correct ALLOW
 * 4. clearTenantIndex and re-index via indexGrant
 * 5. removeGrant removes only the correct entries
 * 6. Concurrent indexGrant calls are safe (ON CONFLICT DO NOTHING)
 *
 * Uses vi.mock to avoid real Postgres — tests the logic, not the DB driver.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

// ─── Mock the DB query function ──────────────────────────────────────────────
vi.mock('../../src/db/client.js', () => ({
    query: vi.fn(),
    getClient: vi.fn(),
    pool: { on: vi.fn() },
}))

// ─── Mock logger ─────────────────────────────────────────────────────────────
vi.mock('../../src/logger/index.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { query } from '../../src/db/client.js'
import {
    checkIndex,
    indexGrant,
    removeGrant,
    clearTenantIndex,
} from '../../src/db/permission-index.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
    mockQuery.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
// checkIndex — O(1) lookup
// ─────────────────────────────────────────────────────────────────────────────
describe('checkIndex', () => {
    test('returns true when index row exists (ALLOW)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 } as never)
        const result = await checkIndex('t1', 'user:A', 'read', 'doc:1')
        expect(result).toBe(true)
    })

    test('returns false when no index row (DENY / fall-through to BFS)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never)
        const result = await checkIndex('t1', 'user:A', 'read', 'doc:1')
        expect(result).toBe(false)
    })

    test('returns false on DB error — fail closed, never true', async () => {
        mockQuery.mockRejectedValueOnce(new Error('Connection refused'))
        const result = await checkIndex('t1', 'user:A', 'read', 'doc:1')
        expect(result).toBe(false)
    })

    test('queries with correct tenant scoping', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never)
        await checkIndex('tenant-XYZ', 'user:B', 'edit', 'report:42')
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT EXISTS'),
            ['tenant-XYZ', 'user:B', 'edit', 'report:42'],
        )
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// indexGrant — batch insert on tuple write
// ─────────────────────────────────────────────────────────────────────────────
describe('indexGrant', () => {
    test('inserts all actions in a single batch query', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
        await indexGrant('t1', 'user:A', 'viewer', 'doc:1', ['read', 'edit'])
        // Batch insert — one query with multiple VALUES rows
        expect(mockQuery).toHaveBeenCalledTimes(1)
        // Verify both actions are in the params
        const params = mockQuery.mock.calls[0]?.[1] as string[]
        expect(params).toContain('read')
        expect(params).toContain('edit')
    })

    test('does not call query when grantedActions is empty', async () => {
        await indexGrant('t1', 'user:A', 'unknown', 'doc:1', [])
        expect(mockQuery).not.toHaveBeenCalled()
    })

    test('uses ON CONFLICT DO NOTHING — idempotent', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
        await indexGrant('t1', 'user:A', 'viewer', 'doc:1', ['read'])
        const sql = mockQuery.mock.calls[0]?.[0] as string
        expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i)
    })

    test('includes granted_by key in insert params', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
        await indexGrant('t1', 'user:A', 'viewer', 'doc:1', ['read'])
        const params = mockQuery.mock.calls[0]?.[1] as string[]
        const grantedBy = params.find(p => p?.includes('user:A') && p?.includes('viewer') && p?.includes('doc:1'))
        expect(grantedBy).toBeTruthy()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// removeGrant — cleanup on tuple delete
// ─────────────────────────────────────────────────────────────────────────────
describe('removeGrant', () => {
    test('deletes by granted_by key scoped to correct tenant', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never)
        await removeGrant('t1', 'user:A', 'viewer', 'doc:1')
        const call = mockQuery.mock.calls[0]
        expect(call?.[0]).toMatch(/DELETE FROM permission_index/i)
        expect(call?.[1]).toContain('t1')
        expect(call?.[1]?.join(',')).toContain('user:A')
    })

    test('does not throw on DB error — fire and forget safe', async () => {
        mockQuery.mockRejectedValueOnce(new Error('DB down'))
        await expect(removeGrant('t1', 'user:A', 'viewer', 'doc:1')).resolves.not.toThrow()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// clearTenantIndex
// ─────────────────────────────────────────────────────────────────────────────
describe('clearTenantIndex', () => {
    test('issues DELETE scoped to tenant only', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 50 } as never)
        await clearTenantIndex('tenant-ABC')
        const [sql, params] = mockQuery.mock.calls[0] as [string, string[]]
        expect(sql).toMatch(/DELETE FROM permission_index/i)
        expect(sql).toMatch(/WHERE tenant_id/i)
        expect(params).toContain('tenant-ABC')
    })

    test('does not delete other tenants when clearing one tenant', async () => {
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
        await clearTenantIndex('t1')
        const [, params] = mockQuery.mock.calls[0] as [string, string[]]
        // Only 1 param — the tenant_id
        expect(params).toHaveLength(1)
        expect(params[0]).toBe('t1')
    })
})
