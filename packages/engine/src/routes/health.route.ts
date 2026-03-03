/**
 * GET /v1/health — health check endpoint (no auth required)
 * GET /v1/logs   — recent decision logs for this tenant (auth required)
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'

export async function healthRoute(fastify: FastifyInstance): Promise<void> {

    // GET /v1/health — liveness check, no auth
    fastify.get('/health', async (_request, reply) => {
        try {
            await query('SELECT 1')
            return reply.status(200).send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                db: 'connected',
            })
        } catch {
            // DB is down — still return 200 so load balancers keep the pod up
            // but signal the issue via the db field
            return reply.status(200).send({
                status: 'degraded',
                timestamp: new Date().toISOString(),
                db: 'error',
            })
        }
    })

    // GET /v1/logs — recent decisions for the authenticated tenant
    // Used by the dashboard decision log feed (auto-refreshes every 5s)
    fastify.get('/logs', {
        preHandler: authMiddleware,
    }, async (request, reply) => {
        try {
            const result = await query<{
                id: string
                subject: string
                action: string
                object: string
                decision: string
                status: string
                reason: string | null
                trace: unknown
                suggested_fix: unknown
                latency_ms: string
                cache_hit: boolean
                created_at: string
            }>(
                `SELECT id, subject, action, object, decision, status,
                reason, trace, suggested_fix, latency_ms, cache_hit, created_at
         FROM   decision_logs
         WHERE  tenant_id = $1
         ORDER  BY created_at DESC
         LIMIT  100`,
                [request.tenantId]
            )

            return reply.status(200).send({ logs: result.rows })

        } catch (error) {
            logger.error({ error: (error as Error).message }, 'logs_fetch_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
