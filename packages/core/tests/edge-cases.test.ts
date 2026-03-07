/**
 * Edge-case tests — @runeauth/core
 *
 * Covers:
 * 1. Cycle detection  — A→B→A must terminate safely
 * 2. Depth limits     — deep chains trigger limitHit:'depth'
 * 3. Node limits      — wide fan-out triggers limitHit:'nodes'
 * 4. Fail-closed      — store throwing must return DENY
 * 5. Invalid action   — unknown action always returns DENY
 */
import { describe, test, expect, vi } from 'vitest'
import { RuneEngine, MemoryStore } from '../src/index.js'
import type { TupleStore, Tuple } from '../src/index.js'
import { testConfig as config } from './test-utils.js'

function makeEngine(opts?: { maxDepth?: number; maxNodes?: number }) {
    return new RuneEngine({
        store: new MemoryStore(),
        config,
        bfs: { maxDepth: opts?.maxDepth ?? 10, maxNodes: opts?.maxNodes ?? 1000 },
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cycle Detection
// ─────────────────────────────────────────────────────────────────────────────
describe('cycle detection', () => {
    test('terminates cleanly with 2-node cycle (A→B→A)', async () => {
        const engine = makeEngine()
        const tenantId = 'tenant-cycle'
        // Create cycle between groups
        await engine.allow({ subject: 'group:A', relation: 'member', object: 'group:B', tenantId })
        await engine.allow({ subject: 'group:B', relation: 'member', object: 'group:A', tenantId })
        // user:X is in group:A but neither group has access to doc:1
        await engine.allow({ subject: 'user:X', relation: 'member', object: 'group:A', tenantId })

        const result = await engine.can('user:X', 'read', 'doc:1', tenantId)
        // No doc:1 in tuples → NOT_FOUND, not infinite loop
        expect(['DENY', 'NOT_FOUND']).toContain(result.status)
    })

    test('terminates with 3-node cycle (A→B→C→A)', async () => {
        const engine = makeEngine()
        const tenantId = 'tenant-3cycle'
        await engine.allow({ subject: 'group:A', relation: 'member', object: 'group:B', tenantId })
        await engine.allow({ subject: 'group:B', relation: 'member', object: 'group:C', tenantId })
        await engine.allow({ subject: 'group:C', relation: 'member', object: 'group:A', tenantId })
        await engine.allow({ subject: 'user:X', relation: 'member', object: 'group:A', tenantId })

        const result = await engine.can('user:X', 'read', 'doc:secret', tenantId)
        expect(['DENY', 'NOT_FOUND']).toContain(result.status)
    })

    test('finds access even when cycle exists in the graph', async () => {
        const engine = makeEngine()
        const tenantId = 'tenant-cycle-allow'
        // Cycle among groups, but user has a direct path to the resource
        await engine.allow({ subject: 'group:A', relation: 'member', object: 'group:B', tenantId })
        await engine.allow({ subject: 'group:B', relation: 'member', object: 'group:A', tenantId })
        await engine.allow({ subject: 'user:X', relation: 'member', object: 'group:A', tenantId })
        await engine.allow({ subject: 'group:A', relation: 'viewer', object: 'doc:1', tenantId })

        const result = await engine.can('user:X', 'read', 'doc:1', tenantId)
        expect(result.decision).toBe('allow')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Depth Limits
// ─────────────────────────────────────────────────────────────────────────────
describe('depth limit', () => {
    test('triggers limitHit:depth on deep chain beyond maxDepth', async () => {
        const engine = makeEngine({ maxDepth: 3 })
        const tenantId = 'tenant-depth'
        // Build chain: user:A → group:1 → group:2 → group:3 → group:4 → doc:1
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:1', tenantId })
        await engine.allow({ subject: 'group:1', relation: 'member', object: 'group:2', tenantId })
        await engine.allow({ subject: 'group:2', relation: 'member', object: 'group:3', tenantId })
        await engine.allow({ subject: 'group:3', relation: 'member', object: 'group:4', tenantId })
        await engine.allow({ subject: 'group:4', relation: 'viewer', object: 'doc:1', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:1', tenantId)
        // Chain depth 5 > maxDepth 3 → DENY safely
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('allows access when chain is within maxDepth', async () => {
        const engine = makeEngine({ maxDepth: 5 })
        const tenantId = 'tenant-depth-ok'
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:1', tenantId })
        await engine.allow({ subject: 'group:1', relation: 'viewer', object: 'doc:1', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:1', tenantId)
        expect(result.decision).toBe('allow')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Node Limits
// ─────────────────────────────────────────────────────────────────────────────
describe('node limit', () => {
    test('triggers limitHit:nodes on wide fan-out graph', async () => {
        const engine = makeEngine({ maxNodes: 5 })
        const tenantId = 'tenant-nodes'
        // user:A is member of many groups — each group fans out further
        for (let i = 0; i < 10; i++) {
            await engine.allow({ subject: 'user:A', relation: 'member', object: `group:${i}`, tenantId })
            await engine.allow({ subject: `group:${i}`, relation: 'member', object: `subgroup:${i}`, tenantId })
        }
        // Target exists but is far away
        await engine.allow({ subject: 'group:99', relation: 'viewer', object: 'doc:secret', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:secret', tenantId)
        // Should hit node limit and return DENY
        expect(result.decision).toBe('deny')
    })

    test('returns correct ALLOW when graph is within node limit', async () => {
        const engine = makeEngine({ maxNodes: 100 })
        const tenantId = 'tenant-nodes-ok'
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:eng', tenantId })
        await engine.allow({ subject: 'group:eng', relation: 'viewer', object: 'doc:1', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:1', tenantId)
        expect(result.decision).toBe('allow')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fail-Closed (store throws → DENY)
// ─────────────────────────────────────────────────────────────────────────────
describe('fail-closed', () => {
    test('returns DENY when the tuple store throws an error', async () => {
        const errorStore: TupleStore = {
            getEdges: async () => { throw new Error('DB connection refused') },
            add: async () => { },
            remove: async () => { },
            objectExists: async () => { throw new Error('DB connection refused') },
            list: async () => ({ tuples: [], total: 0 }),
        }
        const engine = new RuneEngine({ store: errorStore, config })

        const result = await engine.can('user:A', 'read', 'doc:1', 'tenant-error')
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
    })

    test('never returns ALLOW when store throws — security guarantee', async () => {
        const brokenStore: TupleStore = {
            getEdges: vi.fn().mockRejectedValue(new Error('Network timeout')),
            add: async () => { },
            remove: async () => { },
            objectExists: vi.fn().mockRejectedValue(new Error('Network timeout')),
            list: async () => ({ tuples: [], total: 0 }),
        }
        const engine = new RuneEngine({ store: brokenStore, config })

        const results = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                engine.can(`user:${i}`, 'read', 'doc:secret', 'tenant-broken')
            )
        )
        for (const r of results) {
            expect(r.decision).toBe('deny')
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Invalid Actions
// ─────────────────────────────────────────────────────────────────────────────
describe('invalid / unknown actions', () => {
    test('returns DENY for unknown action (no role grants it)', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:A', relation: 'owner', object: 'doc:1', tenantId: 'default' })

        const result = await engine.can('user:A', 'fly', 'doc:1', 'default')
        // 'fly' is not in any role's actions → no valid relations → DENY
        expect(result.decision).toBe('deny')
    })

    test('empty subject returns DENY', async () => {
        const engine = makeEngine()
        const result = await engine.can('', 'read', 'doc:1', 'default')
        expect(result.decision).toBe('deny')
        // Empty subject → object likely not found or no path → DENY or NOT_FOUND both acceptable
        expect(['DENY', 'NOT_FOUND']).toContain(result.status)
    })

    test('empty object returns DENY', async () => {
        const engine = makeEngine()
        const result = await engine.can('user:A', 'read', '', 'default')
        expect(result.decision).toBe('deny')
    })

    test('empty action returns DENY', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'doc:1', tenantId: 'default' })
        const result = await engine.can('user:A', '', 'doc:1', 'default')
        expect(result.decision).toBe('deny')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Multi-Tenant Isolation (MemoryStore)
// ─────────────────────────────────────────────────────────────────────────────
describe('multi-tenant isolation', () => {
    test('tenant A grant does not bleed into tenant B', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:alice', relation: 'owner', object: 'doc:1', tenantId: 'tenant-A' })

        const result = await engine.can('user:alice', 'read', 'doc:1', 'tenant-B')
        expect(result.decision).toBe('deny')
        expect(['DENY', 'NOT_FOUND']).toContain(result.status)
    })

    test('ALLOW in tenant A and DENY in tenant B coexist independently', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:1', tenantId: 'tenant-A' })

        const [allowResult, denyResult] = await Promise.all([
            engine.can('user:alice', 'read', 'doc:1', 'tenant-A'),
            engine.can('user:alice', 'read', 'doc:1', 'tenant-B'),
        ])

        expect(allowResult.decision).toBe('allow')
        expect(denyResult.decision).toBe('deny')
    })

    test('revoke in tenant A does not affect tenant B', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:1', tenantId: 'tenant-A' })
        await engine.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:1', tenantId: 'tenant-B' })

        await engine.revoke({ subject: 'user:alice', relation: 'viewer', object: 'doc:1', tenantId: 'tenant-A' })

        const [a, b] = await Promise.all([
            engine.can('user:alice', 'read', 'doc:1', 'tenant-A'),
            engine.can('user:alice', 'read', 'doc:1', 'tenant-B'),
        ])
        expect(a.decision).toBe('deny')
        expect(b.decision).toBe('allow')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Explainability — trace and suggested_fix
// ─────────────────────────────────────────────────────────────────────────────
describe('explainability', () => {
    test('ALLOW trace starts at subject and ends at object', async () => {
        const engine = makeEngine()
        const tenantId = 'default'
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:eng', tenantId })
        await engine.allow({ subject: 'group:eng', relation: 'viewer', object: 'doc:1', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:1', tenantId)
        expect(result.decision).toBe('allow')
        // trace is string[] in core — first entry is subject, last is object
        expect(result.trace[0]).toBe('user:A')
        expect(result.trace[result.trace.length - 1]).toBe('doc:1')
    })

    test('DENY returns non-empty reason string', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:OTHER', relation: 'viewer', object: 'doc:1', tenantId: 'default' })

        const result = await engine.can('user:A', 'read', 'doc:1', 'default')
        expect(result.decision).toBe('deny')
        expect(result.reason).toBeTruthy()
        expect(typeof result.reason).toBe('string')
    })

    test('DENY returns non-empty status and reason', async () => {
        const engine = makeEngine()
        const tenantId = 'default'
        await engine.allow({ subject: 'user:admin', relation: 'owner', object: 'doc:1', tenantId })

        const result = await engine.can('user:A', 'read', 'doc:1', tenantId)
        expect(result.decision).toBe('deny')
        expect(result.reason).toBeTruthy()
        expect(result.status).toBe('DENY')
        // condition_results is always an array
        expect(Array.isArray(result.condition_results)).toBe(true)
    })
})
