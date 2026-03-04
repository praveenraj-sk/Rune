/**
 * GET /v1/stats — dashboard counters (auth required)
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db/client.js'
import { cache } from '../cache/lru.js'
import { logger } from '../logger/index.js'

export async function statsRoute(fastify: FastifyInstance): Promise<void> {

    fastify.get('/stats', {
        preHandler: authMiddleware,
    }, async (request, reply) => {
        const tenantId = request.tenantId

        try {
            const [tuplesCount, decisionsToday, recentDecisions] = await Promise.all([
                query<{ count: string }>(
                    `SELECT COUNT(*) as count FROM tuples WHERE tenant_id = $1`,
                    [tenantId]
                ),
                query<{ count: string; allow_count: string; deny_count: string }>(
                    `SELECT
                        COUNT(*) as count,
                        COUNT(*) FILTER (WHERE decision = 'allow') as allow_count,
                        COUNT(*) FILTER (WHERE decision = 'deny') as deny_count
                     FROM decision_logs
                     WHERE tenant_id = $1
                       AND created_at >= CURRENT_DATE`,
                    [tenantId]
                ),
                query<{ latency_ms: string }>(
                    `SELECT latency_ms FROM decision_logs
                     WHERE tenant_id = $1
                     ORDER BY created_at DESC LIMIT 100`,
                    [tenantId]
                ),
            ])

            const latencies = recentDecisions.rows.map(r => parseFloat(r.latency_ms)).filter(n => !isNaN(n))
            const avgLatency = latencies.length > 0
                ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100
                : 0

            const todayRow = decisionsToday.rows[0]

            return reply.status(200).send({
                total_tuples: parseInt(tuplesCount.rows[0]?.count ?? '0', 10),
                decisions_today: parseInt(todayRow?.count ?? '0', 10),
                allow_today: parseInt(todayRow?.allow_count ?? '0', 10),
                deny_today: parseInt(todayRow?.deny_count ?? '0', 10),
                avg_latency_ms: avgLatency,
                cache_stats: cache.getStats(),
            })
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'stats_fetch_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
