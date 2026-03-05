/**
 * Mode routing unit tests — @runeauth/core engine.
 *
 * Tests that the correct evaluator is invoked per resource mode,
 * without needing a real database. Uses MemoryStore for isolation.
 */
import { describe, test, expect } from 'vitest'
import { RuneEngine, MemoryStore } from '../src/index.js'
import type { RuneConfig } from '../src/index.js'

// ------------------------------------------------------------------
// Shared config covering all 4 modes
// ------------------------------------------------------------------
const config: RuneConfig = {
    version: 1,
    resources: {
        // Full BFS traversal (default)
        shipment: {
            mode: 'rebac',
            roles: {
                owner: { actions: ['read', 'edit', 'delete', 'manage'] },
                viewer: { actions: ['read'] },
            },
        },
        // One-hop direct check only
        report: {
            mode: 'rbac',
            roles: {
                admin: { actions: ['read', 'edit', 'delete'] },
                viewer: { actions: ['read'] },
            },
        },
        // Condition-only, no tuples
        endpoint: {
            mode: 'abac',
            roles: {},
            conditions: {
                office_hours: {
                    when: { time_between: ['09:00', '17:00'] },
                    apply_to: ['read'],
                },
            },
        },
        // RBAC fast-path, BFS fallback
        document: {
            mode: 'hybrid',
            roles: {
                owner: { actions: ['read', 'edit', 'delete'] },
                viewer: { actions: ['read'] },
            },
        },
    },
}

function makeEngine() {
    return new RuneEngine({ store: new MemoryStore(), config })
}

// ------------------------------------------------------------------
// ReBAC mode
// ------------------------------------------------------------------
describe('mode: rebac', () => {
    test('allows via graph traversal (user → group → resource)', async () => {
        const engine = makeEngine()
        const tenantId = 'default'
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:eng', tenantId })
        await engine.allow({ subject: 'group:eng', relation: 'owner', object: 'shipment:TN001', tenantId })

        const result = await engine.can('user:A', 'read', 'shipment:TN001', tenantId)
        expect(result.decision).toBe('allow')
        expect(result.mode_used).toBe('rebac')
    })

    test('denies when no path exists', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'shipment:TN001', tenantId: 'default' })

        const result = await engine.can('user:B', 'read', 'shipment:TN001', 'default')
        expect(result.decision).toBe('deny')
        expect(result.status).toBe('DENY')
        expect(result.mode_used).toBe('rebac')
    })

    test('returns NOT_FOUND when object does not exist', async () => {
        const engine = makeEngine()
        const result = await engine.can('user:A', 'read', 'shipment:ghost', 'default')
        expect(result.status).toBe('NOT_FOUND')
        expect(result.mode_used).toBe('rebac')
    })
})

// ------------------------------------------------------------------
// RBAC mode (no BFS — one-hop only)
// ------------------------------------------------------------------
describe('mode: rbac', () => {
    test('allows with direct role assignment', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'report:q4', tenantId: 'default' })

        const result = await engine.can('user:A', 'read', 'report:q4', 'default')
        expect(result.decision).toBe('allow')
        expect(result.mode_used).toBe('rbac')
    })

    test('does NOT traverse graph — group member denied without direct role', async () => {
        const engine = makeEngine()
        const tenantId = 'default'
        // Give group:eng a role, add user to group — rbac should NOT traverse
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:eng', tenantId })
        await engine.allow({ subject: 'group:eng', relation: 'admin', object: 'report:q4', tenantId })

        const result = await engine.can('user:A', 'read', 'report:q4', tenantId)
        // rbac mode does one-hop only: user:A has no direct role on report:q4
        expect(result.decision).toBe('deny')
        expect(result.mode_used).toBe('rbac')
    })
})

// ------------------------------------------------------------------
// ABAC mode (no tuples — conditions only)
// ------------------------------------------------------------------
describe('mode: abac', () => {
    test('allows when inside time window (UTC)', async () => {
        const engine = makeEngine()
        const ctx = { time: new Date('2024-01-15T10:00:00Z') }  // 10:00 UTC
        const result = await engine.can('user:A', 'read', 'endpoint:api', 'default', ctx)
        expect(result.decision).toBe('allow')
        expect(result.mode_used).toBe('abac')
    })

    test('denies when outside time window (UTC)', async () => {
        const engine = makeEngine()
        const ctx = { time: new Date('2024-01-15T20:00:00Z') }  // 20:00 UTC
        const result = await engine.can('user:A', 'read', 'endpoint:api', 'default', ctx)
        expect(result.decision).toBe('deny')
        expect(result.mode_used).toBe('abac')
    })

    test('denies by default when no conditions defined', async () => {
        const engine = new RuneEngine({
            store: new MemoryStore(),
            config: {
                version: 1,
                resources: {
                    empty_abac: { mode: 'abac', roles: {} },
                },
            },
        })
        const result = await engine.can('user:A', 'read', 'empty_abac:x', 'default')
        expect(result.decision).toBe('deny')
        expect(result.reason).toContain('no conditions defined')
    })
})

// ------------------------------------------------------------------
// Hybrid mode (RBAC fast-path → BFS fallback)
// ------------------------------------------------------------------
describe('mode: hybrid', () => {
    test('allows via direct role (no BFS needed)', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:A', relation: 'owner', object: 'document:readme', tenantId: 'default' })

        const result = await engine.can('user:A', 'read', 'document:readme', 'default')
        expect(result.decision).toBe('allow')
        expect(result.mode_used).toBe('hybrid')
        // path should be short (direct: user:A → document:readme)
        expect(result.trace).toHaveLength(2)
    })

    test('falls back to BFS for transitive permissions', async () => {
        const engine = makeEngine()
        const tenantId = 'default'
        // No direct role; access via group
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:writers', tenantId })
        await engine.allow({ subject: 'group:writers', relation: 'viewer', object: 'document:readme', tenantId })

        const result = await engine.can('user:A', 'read', 'document:readme', tenantId)
        expect(result.decision).toBe('allow')
        expect(result.mode_used).toBe('hybrid')
        // path traverses group
        expect(result.trace.length).toBeGreaterThan(2)
    })

    test('denies when neither direct role nor graph path exists', async () => {
        const engine = makeEngine()
        await engine.allow({ subject: 'user:other', relation: 'viewer', object: 'document:readme', tenantId: 'default' })

        const result = await engine.can('user:A', 'read', 'document:readme', 'default')
        expect(result.decision).toBe('deny')
        expect(result.mode_used).toBe('hybrid')
    })
})

// ------------------------------------------------------------------
// Policy validation
// ------------------------------------------------------------------
describe('policy validation', () => {
    test('throws on unknown mode at startup', () => {
        expect(() => new RuneEngine({
            store: new MemoryStore(),
            config: {
                version: 1,
                // @ts-expect-error intentionally bad mode
                resources: { bad: { mode: 'supermode', roles: {} } },
            },
        })).toThrow(/unknown mode/)
    })

    test('defaults to rebac when mode is omitted', async () => {
        const engine = new RuneEngine({
            store: new MemoryStore(),
            config: {
                version: 1,
                resources: { widget: { roles: { viewer: { actions: ['read'] } } } },
            },
        })
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'widget:w1', tenantId: 'default' })
        const result = await engine.can('user:A', 'read', 'widget:w1', 'default')
        expect(result.mode_used).toBe('rebac')
        expect(result.decision).toBe('allow')
    })
})
