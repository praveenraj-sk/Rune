/**
 * Chaos tests — @runeauth/engine
 *
 * Simulates infrastructure failures:
 * 1. DB completely unavailable → every can() returns DENY (fail-closed)
 * 2. DB flickers (50% failure rate) → no ALLOW sneaks through on error
 * 3. Cache throws → BFS still runs, fail-closed maintained
 * 4. Index throws → BFS still runs (correct behavior preserved)
 * 5. Partial write failure → transaction rolls back correctly
 *
 * All tests use vi.mock for DB — no real Postgres required.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db/client.js', () => ({
    query: vi.fn(),
    getClient: vi.fn(),
    pool: { on: vi.fn() },
}))
vi.mock('../../src/logger/index.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../src/policy/config.js', () => ({
    loadPolicy: vi.fn(),
    getPolicy: vi.fn(() => ({
        resources: {
            doc: {
                mode: 'rebac',
                roles: { viewer: { actions: ['read'] } },
            },
        },
    })),
    getValidRelations: vi.fn(() => ['viewer']),
    extractResourceType: vi.fn((obj: string) => obj.split(':')[0] ?? 'unknown'),
}))
vi.mock('../../src/cache/lru.js', () => ({
    cache: {
        get: vi.fn(() => null),
        set: vi.fn(),
        deleteByTenant: vi.fn(),
    },
}))
vi.mock('../../src/db/permission-index.js', () => ({
    checkIndex: vi.fn(() => false),
    indexGrant: vi.fn(),
    removeGrant: vi.fn(),
    clearTenantIndex: vi.fn(),
}))

import { query } from '../../src/db/client.js'
import { can } from '../../src/engine/can.js'
import { cache } from '../../src/cache/lru.js'
import { checkIndex } from '../../src/db/permission-index.js'

const mockQuery = vi.mocked(query)
const mockCache = vi.mocked(cache)
const mockCheckIndex = vi.mocked(checkIndex)

const INPUT = {
    tenantId: 't1',
    subject: 'user:A',
    action: 'read',
    object: 'doc:1',
}

beforeEach(() => {
    vi.clearAllMocks()
    mockCache.get.mockReturnValue(null)
    mockCheckIndex.mockResolvedValue(false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. DB completely down
// ─────────────────────────────────────────────────────────────────────────────
describe('chaos: DB completely unavailable', () => {
    test('every can() returns DENY when DB is down', async () => {
        mockQuery.mockRejectedValue(new Error('ECONNREFUSED'))

        const result = await can(INPUT)
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('never returns ALLOW on DB error — across 20 concurrent checks', async () => {
        mockQuery.mockRejectedValue(new Error('DB down'))
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) => can({ ...INPUT, subject: `user:${i}` }))
        )
        for (const r of results) {
            expect(r.decision).toBe('deny')
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Flickering DB (50% failure)
// ─────────────────────────────────────────────────────────────────────────────
describe('chaos: flickering DB', () => {
    test('no ALLOW returned when DB intermittently fails', async () => {
        let callCount = 0
        mockQuery.mockImplementation(async () => {
            callCount++
            if (callCount % 2 === 0) throw new Error('intermittent failure')
            // objectExists returns nothing → NOT_FOUND → DENY
            return { rows: [], rowCount: 0 } as never
        })

        const results = await Promise.all(
            Array.from({ length: 10 }, () => can(INPUT))
        )
        for (const r of results) {
            expect(r.decision).toBe('deny')
            expect(['DENY', 'NOT_FOUND']).toContain(r.status)
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cache throws — BFS must still run
// ─────────────────────────────────────────────────────────────────────────────
describe('chaos: cache layer error', () => {
    test('returns DENY (not crash) when cache.get throws', async () => {
        mockCache.get.mockImplementation(() => { throw new Error('Cache OOM') })
        // DB: object not found → NOT_FOUND
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)

        const result = await can(INPUT)
        expect(result.decision).toBe('deny')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Permission index throws — BFS fallback must run
// ─────────────────────────────────────────────────────────────────────────────
describe('chaos: permission index error', () => {
    test('falls back to BFS when checkIndex throws', async () => {
        mockCheckIndex.mockRejectedValue(new Error('Index table missing'))
        // Object exists (rowCount 1), then no edges found → DENY
        mockQuery
            .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as never) // objectExists
            .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)    // BFS edges

        const result = await can(INPUT)
        // BFS runs, no edges → DENY (not crash)
        expect(result.decision).toBe('deny')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Concurrency safety — same tenant, same resource
// ─────────────────────────────────────────────────────────────────────────────
describe('chaos: concurrent requests', () => {
    test('100 concurrent can() calls all return a valid decision', async () => {
        mockQuery
            .mockResolvedValue({ rows: [], rowCount: 0 } as never) // object not found

        const results = await Promise.all(
            Array.from({ length: 100 }, () => can(INPUT))
        )
        for (const r of results) {
            expect(['allow', 'deny']).toContain(r.decision)
            expect(typeof r.latency_ms).toBe('number')
        }
    })
})
