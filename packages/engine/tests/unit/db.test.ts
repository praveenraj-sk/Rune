/**
 * Database schema constraint tests.
 * Verifies all CHECK constraints, UNIQUE constraints, indexes, and sequences.
 * These tests protect against accidental schema regressions.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { query } from '../../src/db/client.js'

const T = 'cccccccc-cccc-cccc-cccc-cccccccccccc'  // dedicated test tenant

beforeAll(async () => {
    await query('DELETE FROM tuples        WHERE tenant_id = $1', [T])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [T])
    await query('DELETE FROM schemas        WHERE tenant_id = $1', [T])
    await query('DELETE FROM api_keys       WHERE tenant_id = $1', [T])
})

afterAll(async () => {
    await query('DELETE FROM tuples        WHERE tenant_id = $1', [T])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [T])
    await query('DELETE FROM schemas        WHERE tenant_id = $1', [T])
    await query('DELETE FROM api_keys       WHERE tenant_id = $1', [T])
})

// ── tuples table ─────────────────────────────────────────────────────────────

describe('tuples table', () => {
    test('accepts all 4 valid relations', async () => {
        for (const relation of ['owner', 'editor', 'viewer', 'member']) {
            await expect(
                query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                       VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
                    [T, `user:test`, relation, `resource:${relation}`])
            ).resolves.not.toThrow()
        }
    })

    test('accepts any non-empty relation (relations are config-driven, not DB-constrained)', async () => {
        // NOTE: relation is intentionally unconstrained at the DB level — relations
        // are config-driven per tenant (rune.config.yml) and vary across deployments.
        // The schema comment on line 19-20 documents this explicitly.
        await expect(
            query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                   VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
                [T, 'user:badactor', 'superadmin', 'resource:x'])
        ).resolves.not.toThrow()
    })

    test('rejects duplicate primary key (tenant+subject+relation+object)', async () => {
        await query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                     VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
            [T, 'user:dup', 'viewer', 'resource:dup'])

        await expect(
            query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                   VALUES ($1,$2,$3,$4,2)`,
                [T, 'user:dup', 'viewer', 'resource:dup'])
        ).rejects.toThrow()
    })

    test('same subject+relation+object allowed across different tenants', async () => {
        const T2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
        await query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                     VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
            [T, 'user:shared', 'viewer', 'resource:shared'])
        await expect(
            query(`INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                   VALUES ($1,$2,$3,$4,1) ON CONFLICT DO NOTHING`,
                [T2, 'user:shared', 'viewer', 'resource:shared'])
        ).resolves.not.toThrow()
    })

    test('all required indexes exist', async () => {
        const { rows } = await query<{ indexname: string }>(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'tuples'`
        )
        const names = rows.map(r => r.indexname)
        expect(names).toContain('idx_tuples_tenant')
        expect(names).toContain('idx_tuples_subject')
        expect(names).toContain('idx_tuples_object')
        expect(names).toContain('idx_tuples_relation_object')
    })
})

// ── decision_logs table ───────────────────────────────────────────────────────

describe('decision_logs table', () => {
    async function insertLog(overrides: Record<string, string> = {}) {
        const defaults = {
            decision: 'allow',
            status: 'ALLOW',
        }
        const d = { ...defaults, ...overrides }
        return query(
            `INSERT INTO decision_logs
             (tenant_id, subject, action, object, decision, status, reason, trace, suggested_fix, lvn, latency_ms, cache_hit)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
            [T, 'user:t', 'read', 'resource:t', d.decision, d.status,
                'test reason', '[]', '[]', 1, 1.5, false]
        )
    }

    test('accepts valid allow decision', async () => {
        await expect(insertLog()).resolves.not.toThrow()
    })

    test('accepts valid deny decision', async () => {
        await expect(insertLog({ decision: 'deny', status: 'DENY' })).resolves.not.toThrow()
    })

    test('rejects invalid decision value', async () => {
        await expect(insertLog({ decision: 'maybe' })).rejects.toThrow()
    })

    test('rejects invalid status value', async () => {
        await expect(insertLog({ status: 'UNKNOWN' })).rejects.toThrow()
    })

    test('accepts all valid status values', async () => {
        for (const status of ['ALLOW', 'DENY', 'CHALLENGE', 'NOT_FOUND']) {
            const decision = status === 'ALLOW' ? 'allow' : 'deny'
            await expect(insertLog({ decision, status })).resolves.not.toThrow()
        }
    })

    test('trace column stores and retrieves valid JSONB', async () => {
        await query(
            `INSERT INTO decision_logs
             (tenant_id, subject, action, object, decision, status, trace, suggested_fix, lvn, latency_ms, cache_hit)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
            [T, 'user:t', 'read', 'resource:t', 'allow', 'ALLOW',
                JSON.stringify([{ node: 'user:t', result: 'start' }]),
                '[]', 1, 1.0, false]
        )
        const { rows } = await query<{ trace: unknown[] }>(
            `SELECT trace FROM decision_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [T]
        )
        expect(Array.isArray(rows[0]?.trace)).toBe(true)
        expect((rows[0]?.trace as Array<{ node: string }>)[0]?.node).toBe('user:t')
    })

    test('all required indexes exist', async () => {
        const { rows } = await query<{ indexname: string }>(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'decision_logs'`
        )
        const names = rows.map(r => r.indexname)
        expect(names).toContain('idx_logs_tenant')
        expect(names).toContain('idx_logs_subject')
        expect(names).toContain('idx_logs_object')
        expect(names).toContain('idx_logs_created')
    })
})

// ── api_keys table ────────────────────────────────────────────────────────────

describe('api_keys table', () => {
    test('rejects duplicate key_hash (UNIQUE constraint)', async () => {
        const hash = 'deadbeef'.repeat(8)  // 64 hex chars
        await query(`INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1,$2,$3)
                     ON CONFLICT DO NOTHING`, [T, hash, 'test-key'])

        await expect(
            query(`INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1,$2,$3)`,
                [T, hash, 'dupe-key'])
        ).rejects.toThrow()
    })

    test('same tenant can have multiple API keys', async () => {
        await expect(
            query(`INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1,$2,$3)`,
                [T, 'aabbccdd'.repeat(8), 'key-a'])
        ).resolves.not.toThrow()
        await expect(
            query(`INSERT INTO api_keys (tenant_id, key_hash, name) VALUES ($1,$2,$3)`,
                [T, 'eeff0011'.repeat(8), 'key-b'])
        ).resolves.not.toThrow()
    })
})

// ── schemas table ─────────────────────────────────────────────────────────────

describe('schemas table', () => {
    // Use a time-based offset so version numbers don't collide across test runs
    const base = Date.now() % 100000

    test('accepts all valid statuses', async () => {
        let v = base
        for (const status of ['active', 'shadow', 'deprecated']) {
            await expect(
                query(`INSERT INTO schemas (tenant_id, version, dsl_body, status) VALUES ($1,$2,$3,$4)`,
                    [T, v++, '{}', status])
            ).resolves.not.toThrow()
        }
    })

    test('rejects invalid status', async () => {
        await expect(
            query(`INSERT INTO schemas (tenant_id, version, dsl_body, status) VALUES ($1,$2,$3,$4)`,
                [T, base + 99999, '{}', 'pending'])
        ).rejects.toThrow()
    })
})

// ── LVN sequence ──────────────────────────────────────────────────────────────

describe('LVN sequence', () => {
    test('increments monotonically', async () => {
        const r1 = await query<{ nextval: string }>('SELECT nextval(\'lvn_seq\')')
        const r2 = await query<{ nextval: string }>('SELECT nextval(\'lvn_seq\')')
        const r3 = await query<{ nextval: string }>('SELECT nextval(\'lvn_seq\')')
        const n1 = Number(r1.rows[0]?.nextval)
        const n2 = Number(r2.rows[0]?.nextval)
        const n3 = Number(r3.rows[0]?.nextval)
        expect(n2).toBeGreaterThan(n1)
        expect(n3).toBeGreaterThan(n2)
    })

    test('all values unique across 20 rapid calls', async () => {
        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                query<{ nextval: string }>('SELECT nextval(\'lvn_seq\')')
                    .then(r => Number(r.rows[0]?.nextval))
            )
        )
        const unique = new Set(results)
        expect(unique.size).toBe(20)
    })
})
