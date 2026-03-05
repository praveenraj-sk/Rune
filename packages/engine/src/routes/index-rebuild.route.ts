/**
 * POST /v1/index/rebuild — Full permission index rebuild for a tenant.
 *
 * Accepts a list of tuples (from GET /v1/tuples), clears the tenant's index,
 * and recomputes all implied permissions via indexGrant.
 *
 * Called by: rune CLI `rune index rebuild`
 * Also safe to call directly if you suspect index corruption.
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { clearTenantIndex, indexGrant } from '../db/permission-index.js'
import { getValidRelations, extractResourceType } from '../policy/config.js'
import { logger } from '../logger/index.js'

type TupleInput = {
    subject: string
    relation: string
    object: string
}

const bodySchema = {
    type: 'object',
    required: ['tuples'],
    properties: {
        tuples: {
            type: 'array',
            items: {
                type: 'object',
                required: ['subject', 'relation', 'object'],
                properties: {
                    subject: { type: 'string', minLength: 1 },
                    relation: { type: 'string', minLength: 1 },
                    object: { type: 'string', minLength: 1 },
                },
            },
        },
    },
} as const

export async function indexRebuildRoute(fastify: FastifyInstance): Promise<void> {
    fastify.post<{ Body: { tuples: TupleInput[] } }>('/index/rebuild', {
        preHandler: [authMiddleware, rateLimitMiddleware],
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const { tuples } = request.body
        const start = performance.now()

        try {
            // Clear existing index for this tenant
            await clearTenantIndex(tenantId)

            const allActions = ['read', 'edit', 'delete', 'manage', 'write', 'approve']
            let indexed = 0

            // Re-index all tuples
            await Promise.all(tuples.map(async (tuple) => {
                const resourceType = extractResourceType(tuple.object)
                const grantedActions = allActions.filter(a =>
                    getValidRelations(a, resourceType).includes(tuple.relation)
                )
                if (grantedActions.length > 0) {
                    await indexGrant(tenantId, tuple.subject, tuple.relation, tuple.object, grantedActions)
                    indexed += grantedActions.length
                }
            }))

            logger.info({ tenantId, tuples: tuples.length, indexed, latency_ms: performance.now() - start }, 'index_rebuild_complete')

            return reply.status(200).send({
                cleared: true,
                tuples_processed: tuples.length,
                indexed,
                latency_ms: Math.round(performance.now() - start),
            })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'index_rebuild_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
