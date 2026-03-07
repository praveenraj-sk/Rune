/**
 * Latency Gate Tests — CI performance guard.
 *
 * These tests assert that the cached decision path stays fast.
 * A regression in cache lookup, serialization, or middleware overhead
 * is caught here before it reaches production.
 *
 * Thresholds (match SLOW_THRESHOLD_MS in can.ts):
 *   - Cached path median  < 5ms
 *   - Cached path P99     < 20ms
 *   - No single call      > 100ms
 *
 * Strategy:
 *   1. Warm the LRU cache with known-good decisions.
 *   2. Run 50 consecutive can() calls against the cached path.
 *   3. Compute median and P99 from the measured latencies.
 *   4. Assert all three thresholds pass.
 *
 * Note: These tests do NOT measure cold BFS traversal latency —
 * that is bounded by Postgres, not application code.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import { LOGISTICS_TENANT, logisticsTuples } from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

const API_KEY = 'rune-test-key-1234567890'
const app = createTestApp()

const MEDIAN_THRESHOLD_MS = 5
const P99_THRESHOLD_MS = 20
const MAX_SINGLE_CALL_MS = 100
const ITERATIONS = 50

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]!
}

beforeAll(async () => { await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    for (const t of logisticsTuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
             VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [LOGISTICS_TENANT, t.subject, t.relation, t.object]
        )
    }
})

describe('⚡ Latency Gates — cached path', () => {

    test(`median < ${MEDIAN_THRESHOLD_MS}ms, P99 < ${P99_THRESHOLD_MS}ms, max < ${MAX_SINGLE_CALL_MS}ms (${ITERATIONS} iterations)`, async () => {
        // Warm the cache: one uncached call to populate the LRU
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })

        // Verify it's now a cache hit
        const warmCheck = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        expect(warmCheck.json<{ cache_hit: boolean }>().cache_hit).toBe(true)

        // Measure ITERATIONS cached calls
        const latencies: number[] = []
        for (let i = 0; i < ITERATIONS; i++) {
            const start = performance.now()
            await app.inject({
                method: 'POST', url: '/v1/can',
                headers: { 'x-api-key': API_KEY },
                payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
            })
            latencies.push(performance.now() - start)
        }

        latencies.sort((a, b) => a - b)
        const median = percentile(latencies, 50)
        const p99 = percentile(latencies, 99)
        const max = latencies[latencies.length - 1]!

        // Surface all numbers in the test output for observability
        console.log(`Latency (${ITERATIONS} cached calls): median=${median.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`)

        expect(median).toBeLessThan(MEDIAN_THRESHOLD_MS)
        expect(p99).toBeLessThan(P99_THRESHOLD_MS)
        expect(max).toBeLessThan(MAX_SINGLE_CALL_MS)
    })

    test('DENY path is equally fast when cached', async () => {
        // Warm cache with a DENY decision
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:MH001' },
        })

        const latencies: number[] = []
        for (let i = 0; i < ITERATIONS; i++) {
            const start = performance.now()
            await app.inject({
                method: 'POST', url: '/v1/can',
                headers: { 'x-api-key': API_KEY },
                payload: { subject: 'user:arjun', action: 'read', object: 'shipment:MH001' },
            })
            latencies.push(performance.now() - start)
        }

        latencies.sort((a, b) => a - b)
        const p99 = percentile(latencies, 99)
        const max = latencies[latencies.length - 1]!

        expect(p99).toBeLessThan(P99_THRESHOLD_MS)
        expect(max).toBeLessThan(MAX_SINGLE_CALL_MS)
    })
})
