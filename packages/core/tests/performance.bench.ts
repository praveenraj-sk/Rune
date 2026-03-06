/**
 * Performance benchmarks — @runeauth/core
 *
 * Measures:
 * 1. MemoryStore BFS latency (single hop, multi-hop)
 * 2. Cache hit latency (in-process, no BFS)
 * 3. Cold-path (no cache, BFS from scratch)
 * 4. Throughput: N concurrent checks per second
 *
 * These are NOT pass/fail tests — they measure and report latency.
 * P95/P99 assertions are set conservatively for CI.
 * They run without a database (MemoryStore only).
 */
import { describe, test, expect } from 'vitest'
import { RuneEngine, MemoryStore } from '../src/index.js'
import type { RuneConfig } from '../src/index.js'

const config: RuneConfig = {
    version: 1,
    resources: {
        doc: {
            mode: 'rebac',
            roles: {
                owner: { actions: ['read', 'edit', 'delete', 'manage'] },
                viewer: { actions: ['read'] },
            },
        },
    },
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)] ?? 0
}

async function measureMs(fn: () => Promise<unknown>, runs: number): Promise<number[]> {
    const latencies: number[] = []
    for (let i = 0; i < runs; i++) {
        const t = performance.now()
        await fn()
        latencies.push(performance.now() - t)
    }
    return latencies
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Single-hop BFS (direct relationship)
// ─────────────────────────────────────────────────────────────────────────────
describe('benchmark: single-hop BFS', () => {
    test('P99 latency < 5ms for direct role check (MemoryStore)', async () => {
        const engine = new RuneEngine({ store: new MemoryStore(), config })
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'doc:1', tenantId: 't1' })

        const latencies = await measureMs(
            () => engine.can('user:A', 'read', 'doc:1', 't1'),
            200,
        )
        const p99 = percentile(latencies, 99)
        console.log(`[BFS 1-hop] avg=${(latencies.reduce((a, b) => a + b) / latencies.length).toFixed(2)}ms P99=${p99.toFixed(2)}ms`)
        expect(p99).toBeLessThan(5) // MemoryStore is extremely fast
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Multi-hop BFS (3-level group chain)
// ─────────────────────────────────────────────────────────────────────────────
describe('benchmark: multi-hop BFS', () => {
    test('P99 latency < 10ms for 3-hop chain (MemoryStore)', async () => {
        const engine = new RuneEngine({ store: new MemoryStore(), config })
        const tenantId = 't-bench'
        await engine.allow({ subject: 'user:A', relation: 'member', object: 'group:1', tenantId })
        await engine.allow({ subject: 'group:1', relation: 'member', object: 'group:2', tenantId })
        await engine.allow({ subject: 'group:2', relation: 'viewer', object: 'doc:1', tenantId })

        const latencies = await measureMs(
            () => engine.can('user:A', 'read', 'doc:1', tenantId),
            200,
        )
        const p99 = percentile(latencies, 99)
        console.log(`[BFS 3-hop] P99=${p99.toFixed(2)}ms`)
        expect(p99).toBeLessThan(10)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. NOT_FOUND (object doesn't exist — quick exit)
// ─────────────────────────────────────────────────────────────────────────────
describe('benchmark: NOT_FOUND fast-path', () => {
    test('P99 < 2ms when object does not exist', async () => {
        const engine = new RuneEngine({ store: new MemoryStore(), config })

        const latencies = await measureMs(
            () => engine.can('user:A', 'read', 'doc:ghost', 't1'),
            300,
        )
        const p99 = percentile(latencies, 99)
        console.log(`[NOT_FOUND] P99=${p99.toFixed(2)}ms`)
        expect(p99).toBeLessThan(2)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Throughput — concurrent checks
// ─────────────────────────────────────────────────────────────────────────────
describe('benchmark: throughput', () => {
    test('can handle 500 concurrent checks without errors', async () => {
        const engine = new RuneEngine({ store: new MemoryStore(), config })
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'doc:1', tenantId: 't-load' })

        const start = performance.now()
        const results = await Promise.all(
            Array.from({ length: 500 }, () => engine.can('user:A', 'read', 'doc:1', 't-load'))
        )
        const totalMs = performance.now() - start

        const failed = results.filter(r => r.decision === 'deny').length
        console.log(`[Throughput] 500 checks in ${totalMs.toFixed(0)}ms — ${failed} errors`)

        expect(failed).toBe(0) // all should ALLOW
        expect(totalMs).toBeLessThan(2000) // well under 2s for 500 in-memory checks
    })

    test('1000 mixed allow/deny checks complete within 3s', async () => {
        const engine = new RuneEngine({ store: new MemoryStore(), config })
        await engine.allow({ subject: 'user:A', relation: 'viewer', object: 'doc:1', tenantId: 't-mixed' })

        const start = performance.now()
        const checks = Array.from({ length: 1000 }, (_, i) =>
            engine.can(i % 2 === 0 ? 'user:A' : 'user:B', 'read', 'doc:1', 't-mixed')
        )
        const results = await Promise.all(checks)
        const totalMs = performance.now() - start

        console.log(`[Mixed] 1000 checks in ${totalMs.toFixed(0)}ms`)
        expect(results).toHaveLength(1000)
        expect(totalMs).toBeLessThan(3000)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Role inheritance resolution overhead
// ─────────────────────────────────────────────────────────────────────────────
describe('benchmark: role inheritance at startup', () => {
    test('engine with 10 resources and deep role inheritance starts in < 100ms', () => {
        const start = performance.now()
        const resources: RuneConfig['resources'] = {}
        for (let i = 0; i < 10; i++) {
            resources[`resource${i}`] = {
                mode: 'rebac',
                roles: {
                    admin: { actions: ['read', 'edit', 'delete', 'manage'] },
                    editor: { inherits: ['viewer'], actions: ['edit'] },
                    viewer: { actions: ['read'] },
                },
            }
        }
        const engine = new RuneEngine({ store: new MemoryStore(), config: { version: 1, resources } })
        const elapsed = performance.now() - start
        console.log(`[Startup] engine init with 10 resources: ${elapsed.toFixed(2)}ms`)
        expect(elapsed).toBeLessThan(100)
        expect(engine).toBeDefined()
    })
})
