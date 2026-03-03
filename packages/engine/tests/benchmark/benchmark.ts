/**
 * Rune Engine Benchmark
 * 
 * Tests 4 scenarios, each run N iterations, reports P50 / P95 / P99 / max latency.
 * Calls can() directly — measures engine only, no HTTP overhead.
 *
 * Run: pnpm benchmark
 */
import 'dotenv/config'
import { query } from '../../src/db/client.js'
import { can } from '../../src/engine/can.js'
import { cache } from '../../src/cache/lru.js'

const BENCH_TENANT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ITERATIONS = 500

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return Number((sorted[Math.max(0, idx)] ?? 0).toFixed(3))
}

function stats(times: number[]) {
    const sorted = [...times].sort((a, b) => a - b)
    return {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
        mean: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)),
    }
}

function line(label: string, s: ReturnType<typeof stats>, extra = '') {
    const pad = (n: number) => String(n).padStart(7)
    console.log(
        `  ${label.padEnd(28)} ` +
        `p50=${pad(s.p50)}ms  p95=${pad(s.p95)}ms  p99=${pad(s.p99)}ms  ` +
        `max=${pad(s.max)}ms  mean=${pad(s.mean)}ms  ${extra}`
    )
}

async function insertTuple(subject: string, relation: string, object: string, lvn = 1) {
    await query(
        `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [BENCH_TENANT, subject, relation, object, lvn]
    )
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    // Warm up (5 calls, results discarded)
    for (let i = 0; i < 5; i++) await fn()

    const times: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
        const t = performance.now()
        await fn()
        times.push(performance.now() - t)
    }
    line(label, stats(times))
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
    await query('DELETE FROM tuples       WHERE tenant_id = $1', [BENCH_TENANT])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [BENCH_TENANT])

    // Scenario 1 — 3-hop chain: user → group → zone → resource
    await insertTuple('user:bench', 'member', 'group:bench')
    await insertTuple('group:bench', 'owner', 'zone:bench')
    await insertTuple('zone:bench', 'viewer', 'resource:bench')

    // Scenario 2 — 8-hop deep chain
    for (let i = 0; i < 8; i++) {
        await insertTuple(`deep:${i}`, 'member', `deep:${i + 1}`)
    }
    await insertTuple('dummy:x', 'viewer', 'deep:target')
    // connect end of chain to target
    await insertTuple('deep:8', 'viewer', 'deep:target')

    // Scenario 3 — wide graph: 1 user → group with 100 members → resource
    await insertTuple('user:wide', 'member', 'group:wide')
    for (let i = 0; i < 100; i++) {
        await insertTuple(`peer:${i}`, 'member', 'group:wide')
    }
    await insertTuple('group:wide', 'viewer', 'resource:wide')
}

async function teardown() {
    await query('DELETE FROM tuples       WHERE tenant_id = $1', [BENCH_TENANT])
    await query('DELETE FROM decision_logs WHERE tenant_id = $1', [BENCH_TENANT])
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log()
    console.log('  🌿 Rune Engine Benchmark')
    console.log(`  ${ITERATIONS} iterations per scenario — calling can() directly (no HTTP)`)
    console.log()

    await setup()

    // ─── 1. Cache HIT ────────────────────────────────────────────────────────
    // Prime the cache first, then measure
    await can({ tenantId: BENCH_TENANT, subject: 'user:bench', action: 'read', object: 'resource:bench' })
    console.log('  ─── Cache HIT ────────────────────────────────────────────────────────────')
    await run('allow (3-hop, cache warm)', () =>
        can({ tenantId: BENCH_TENANT, subject: 'user:bench', action: 'read', object: 'resource:bench' })
    )

    // ─── 2. Cache MISS — 3-hop ───────────────────────────────────────────────
    console.log()
    console.log('  ─── Cache MISS (fresh BFS each call) ────────────────────────────────────')
    await run('allow (3-hop)', () => {
        cache.deleteByTenant(BENCH_TENANT)
        return can({ tenantId: BENCH_TENANT, subject: 'user:bench', action: 'read', object: 'resource:bench' })
    })

    // ─── 3. Cache MISS — 8-hop deep chain ───────────────────────────────────
    await run('allow (8-hop deep)', () => {
        cache.deleteByTenant(BENCH_TENANT)
        return can({ tenantId: BENCH_TENANT, subject: 'deep:0', action: 'read', object: 'deep:target' })
    })

    // ─── 4. Cache MISS — wide graph (100 peers in same group) ────────────────
    await run('allow (wide: 100 peers)', () => {
        cache.deleteByTenant(BENCH_TENANT)
        return can({ tenantId: BENCH_TENANT, subject: 'user:wide', action: 'read', object: 'resource:wide' })
    })

    // ─── 5. DENY — object exists but no path ─────────────────────────────────
    await run('deny  (3-hop, wrong user)', () => {
        cache.deleteByTenant(BENCH_TENANT)
        return can({ tenantId: BENCH_TENANT, subject: 'user:nobody', action: 'read', object: 'resource:bench' })
    })

    // ─── 6. NOT_FOUND ────────────────────────────────────────────────────────
    await run('not_found (ghost resource)', () =>
        can({ tenantId: BENCH_TENANT, subject: 'user:bench', action: 'read', object: 'resource:ghost' })
    )

    console.log()

    await teardown()
    process.exit(0)
}

main().catch((err) => {
    console.error('Benchmark failed:', (err as Error).message)
    process.exit(1)
})
