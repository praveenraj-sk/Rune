/**
 * POST /v1/tuples  — add a relationship
 * DELETE /v1/tuples — remove a relationship
 *
 * Both routes:
 * 1. Require auth (x-api-key)
 * 2. Validate relation is one of 4 valid values
 * 3. Increment LVN on every write
 * 4. Wipe tenant cache on every write (cache invalidation)
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { cache } from '../cache/lru.js'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'

const bodySchema = {
    type: 'object',
    required: ['subject', 'relation', 'object'],
    properties: {
        subject: { type: 'string', minLength: 1 },
        relation: { type: 'string', enum: ['owner', 'editor', 'viewer', 'member'] },
        object: { type: 'string', minLength: 1 },
    },
} as const

type TupleBody = {
    subject: string
    relation: 'owner' | 'editor' | 'viewer' | 'member'
    object: string
}

export async function tuplesRoute(fastify: FastifyInstance): Promise<void> {

    // POST /v1/tuples — add a relationship
    fastify.post<{ Body: TupleBody }>('/tuples', {
        preHandler: authMiddleware,
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const { subject, relation, object } = request.body
        const tenantId = request.tenantId

        try {
            // Get next LVN — every write gets a unique monotone version number
            const lvnResult = await query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
            const lvn = parseInt(lvnResult.rows[0]?.nextval ?? '1', 10)

            // Upsert — idempotent
            await query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, subject, relation, object)
         DO UPDATE SET lvn = EXCLUDED.lvn`,
                [tenantId, subject, relation, object, lvn]
            )

            // Wipe all cached decisions for this tenant — any permission may have changed
            cache.deleteByTenant(tenantId)

            logger.info({ tenantId, subject, relation, object, lvn }, 'tuple_added')
            return reply.status(200).send({ success: true, lvn })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'tuple_add_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })

    // DELETE /v1/tuples — remove a relationship
    fastify.delete<{ Body: TupleBody }>('/tuples', {
        preHandler: authMiddleware,
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const { subject, relation, object } = request.body
        const tenantId = request.tenantId

        try {
            await query(
                `DELETE FROM tuples
         WHERE tenant_id = $1
           AND subject   = $2
           AND relation  = $3
           AND object    = $4`,
                [tenantId, subject, relation, object]
            )

            const lvnResult = await query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
            const lvn = parseInt(lvnResult.rows[0]?.nextval ?? '1', 10)

            // Wipe tenant cache after every write
            cache.deleteByTenant(tenantId)

            logger.info({ tenantId, subject, relation, object, lvn }, 'tuple_removed')
            return reply.status(200).send({ success: true, lvn })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'tuple_delete_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
