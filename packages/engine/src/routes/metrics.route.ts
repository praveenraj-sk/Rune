/**
 * GET /v1/metrics — Prometheus-compatible metrics endpoint.
 *
 * Returns real-time authorization metrics:
 * - Cache hit rate (%)
 * - Permission index hit count
 * - BFS depth histogram
 * - Latency percentiles (p50, p95, p99)
 * - Total allow/deny/error counts
 * - Connection pool stats
 *
 * No auth required — metrics endpoints are typically scraped by monitoring
 * systems (Prometheus, Datadog, Grafana) from inside the network.
 * If you need auth, add preHandler: [authMiddleware].
 */
import type { FastifyInstance } from 'fastify'
import { metrics } from '../metrics/collector.js'
import { cache } from '../cache/lru.js'
import { pool } from '../db/client.js'

export async function metricsRoute(fastify: FastifyInstance): Promise<void> {
    fastify.get('/metrics', async (_request, reply) => {
        const snapshot = metrics.snapshot()
        const cacheStats = cache.getStats()

        return reply.status(200).send({
            ...snapshot,
            cache: {
                size: cacheStats.size,
                max_size: cacheStats.maxSize,
                indexed_keys: cacheStats.indexedKeys,
            },
            pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
            },
        })
    })
}
