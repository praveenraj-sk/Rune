/**
 * GET /v1/index/health — Permission index consistency check.
 *
 * Samples N random tuples from the `tuples` table, runs a BFS decision
 * for each, and compares the result against `permission_index`.
 * Returns a health report: perfect, degraded, or corrupt.
 *
 * Use this after a crash or suspected index drift to verify consistency.
 * Protected by authMiddleware (any valid API key).
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { query } from '../db/client.js'
import { checkIndex } from '../db/permission-index.js'
import { traverse } from '../bfs/traverse.js'
import { getValidRelations, extractResourceType } from '../policy/config.js'
import { logger } from '../logger/index.js'

type SampleTuple = {
    subject: string
    relation: string
    object: string
}

export async function indexHealthRoute(fastify: FastifyInstance): Promise<void> {
    fastify.get<{
        Querystring: { samples?: string }
    }>('/index/health', {
        preHandler: [authMiddleware, rateLimitMiddleware],
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const sampleCount = Math.min(50, Math.max(5, parseInt(request.query.samples ?? '20', 10)))
        const start = performance.now()

        try {
            // Sample random tuples from this tenant
            const samplesResult = await query<SampleTuple>(
                `SELECT subject, relation, object FROM tuples
                 WHERE tenant_id = $1
                 ORDER BY random()
                 LIMIT $2`,
                [tenantId, sampleCount],
            )

            const tuples = samplesResult.rows
            if (tuples.length === 0) {
                return reply.status(200).send({
                    status: 'ok',
                    message: 'No tuples found — index is trivially consistent',
                    checked: 0,
                    mismatches: 0,
                    latency_ms: performance.now() - start,
                })
            }

            // For each sampled tuple, determine what actions the relation grants
            // then check BFS vs index
            const mismatches: Array<{
                subject: string
                action: string
                object: string
                bfs: 'allow' | 'deny'
                index: 'allow' | 'deny'
            }> = []
            let checked = 0

            for (const tuple of tuples) {
                const resourceType = extractResourceType(tuple.object)
                const validRelations = getValidRelations('read', resourceType)

                // Only check tuples where the relation grants at least one common action
                if (!validRelations.includes(tuple.relation)) continue

                // Use 'read' as the test action for simplicity
                const action = 'read'
                checked++

                const [bfsResult, indexResult] = await Promise.all([
                    traverse(tenantId, tuple.subject, tuple.object, action),
                    checkIndex(tenantId, tuple.subject, action, tuple.object),
                ])

                const bfsDecision = bfsResult.found ? 'allow' : 'deny'
                const indexDecision = indexResult ? 'allow' : 'deny'

                // BFS DENY + index ALLOW = stale/corrupt index entry (false ALLOW)
                // BFS ALLOW + index DENY = index lag (missed grant) — falls back to BFS, safe
                if (bfsDecision !== indexDecision && indexDecision === 'allow') {
                    mismatches.push({
                        subject: tuple.subject,
                        action,
                        object: tuple.object,
                        bfs: bfsDecision,
                        index: indexDecision,
                    })
                }
            }

            const status = mismatches.length === 0 ? 'ok'
                : mismatches.length < 3 ? 'degraded'
                    : 'corrupt'

            if (status !== 'ok') {
                logger.warn({ tenantId, mismatches: mismatches.length, checked }, 'perm_index_health_degraded')
            }

            return reply.status(200).send({
                status,
                message: status === 'ok'
                    ? `Index consistent across ${checked} sampled permissions`
                    : `${mismatches.length} stale index entries detected — run index rebuild`,
                checked,
                mismatches: mismatches.length,
                mismatch_details: mismatches,
                latency_ms: Math.round(performance.now() - start),
            })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'index_health_check_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
