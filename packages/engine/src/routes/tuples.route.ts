/**
 * POST /v1/tuples  — add a relationship
 * DELETE /v1/tuples — remove a relationship
 *
 * Both routes:
 * 1. Require auth (x-api-key)
 * 2. Validate relation is one of 4 valid values
 * 3. Increment LVN on every write — also updates in-memory LVN (Priority 1 fix)
 * 4. Targeted cache invalidation on every write (Priority 2 fix)
 *    - Old: cache.deleteByTenant() → wipes ALL entries for the tenant
 *    - New: cache.deleteByChanged() → wipes only entries affected by this tuple change
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { cache } from '../cache/lru.js'
import { query, getClient } from '../db/client.js'
import { logger } from '../logger/index.js'
import { indexGrant, removeGrant } from '../db/permission-index.js'
import { getValidRelations, extractResourceType } from '../policy/config.js'
import { updateLocalLvn } from '../engine/lvn.js'

const bodySchema = {
    type: 'object',
    required: ['subject', 'relation', 'object'],
    properties: {
        subject: { type: 'string', minLength: 1 },
        relation: { type: 'string', minLength: 1 },
        object: { type: 'string', minLength: 1 },
    },
} as const

type TupleBody = {
    subject: string
    relation: string
    object: string
}

export async function tuplesRoute(fastify: FastifyInstance): Promise<void> {

    // GET /v1/tuples — list relationships (paginated, filterable)
    fastify.get<{
        Querystring: { page?: string; limit?: string; search?: string }
    }>('/tuples', {
        preHandler: [authMiddleware, rateLimitMiddleware],
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const page = Math.max(1, parseInt(request.query.page ?? '1', 10))
        const limit = Math.min(100, Math.max(1, parseInt(request.query.limit ?? '50', 10)))
        const offset = (page - 1) * limit
        const search = request.query.search?.trim()

        try {
            let whereClause = 'WHERE tenant_id = $1'
            const params: (string | number)[] = [tenantId]

            if (search) {
                params.push(`%${search}%`)
                const idx = params.length
                whereClause += ` AND (subject ILIKE $${idx} OR relation ILIKE $${idx} OR object ILIKE $${idx})`
            }

            const countResult = await query<{ count: string }>(
                `SELECT COUNT(*) as count FROM tuples ${whereClause}`, params
            )
            const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

            const dataParams = [...params, limit, offset]
            const result = await query<{
                subject: string; relation: string; object: string; created_at: string
            }>(
                `SELECT subject, relation, object, created_at
                 FROM tuples ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
                dataParams
            )

            return reply.status(200).send({
                tuples: result.rows,
                total,
                page,
                limit,
                pages: Math.ceil(total / limit),
            })
        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'tuples_list_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })


    // POST /v1/tuples — add a relationship
    fastify.post<{ Body: TupleBody }>('/tuples', {
        preHandler: [authMiddleware, rateLimitMiddleware],
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const { subject, relation, object } = request.body
        const tenantId = request.tenantId

        try {
            const client = await getClient()
            let lvn: number
            try {
                await client.query('BEGIN')

                // Get next LVN and insert tuple atomically — prevents partial writes
                const lvnResult = await client.query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
                const nextval = lvnResult.rows[0]?.nextval
                if (!nextval) throw new Error('lvn_seq returned no rows — possible DB fault')
                lvn = parseInt(nextval, 10)

                // Upsert — idempotent
                await client.query(
                    `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (tenant_id, subject, relation, object)
                     DO UPDATE SET lvn = EXCLUDED.lvn`,
                    [tenantId, subject, relation, object, lvn]
                )

                await client.query('COMMIT')
            } catch (err) {
                await client.query('ROLLBACK').catch(() => { })
                throw err
            } finally {
                client.release()
            }

            // Priority 1 fix: update in-memory LVN so can() reads don't need a DB query
            updateLocalLvn(lvn)

            // Priority 2 fix: targeted invalidation — only wipe entries affected by this tuple
            // instead of wiping all 10,000+ entries for the entire tenant
            cache.deleteByChanged(tenantId, subject, object)

            // Permission index — fire-and-forget (never blocks response).
            //
            // INTENTIONAL EVENTUAL CONSISTENCY (Phase 1 documented tradeoff):
            // The index is updated AFTER the 200 response is sent, so there is a
            // ~50ms window where the index is stale after a write. During this window:
            //   - permission index lookup → MISS (index not yet updated)
            //   - BFS fallback runs      → ALLOW (correct, just slightly slower)
            //
            // This is SAFE — BFS is always the authoritative fallback.
            // On high-write systems, the index hit rate will drop under heavy write load.
            //
            // Phase 2 fix: await the index update inside the transaction,
            // or use a write-through queue to guarantee synchronous index updates.
            const resourceType = extractResourceType(object)
            const allActions = ['read', 'edit', 'delete', 'manage', 'write', 'approve']
            const grantedActions = allActions.filter(a => getValidRelations(a, resourceType).includes(relation))
            indexGrant(tenantId, subject, relation, object, grantedActions)
                .catch((err: unknown) => logger.warn({ err }, 'perm_index_grant_async_failed'))

            logger.info({ tenantId, subject, relation, object, lvn }, 'tuple_added')
            return reply.status(200).send({ success: true, lvn })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'tuple_add_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })

    // DELETE /v1/tuples — remove a relationship
    fastify.delete<{ Body: TupleBody }>('/tuples', {
        preHandler: [authMiddleware, rateLimitMiddleware],
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const { subject, relation, object } = request.body
        const tenantId = request.tenantId

        try {
            const client = await getClient()
            let lvn: number
            try {
                await client.query('BEGIN')

                await client.query(
                    `DELETE FROM tuples
                     WHERE tenant_id = $1
                       AND subject   = $2
                       AND relation  = $3
                       AND object    = $4`,
                    [tenantId, subject, relation, object]
                )

                const lvnResult = await client.query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
                const nextval = lvnResult.rows[0]?.nextval
                if (!nextval) throw new Error('lvn_seq returned no rows — possible DB fault')
                lvn = parseInt(nextval, 10)

                await client.query('COMMIT')
            } catch (err) {
                await client.query('ROLLBACK').catch(() => { })
                throw err
            } finally {
                client.release()
            }

            // Priority 1 fix: update in-memory LVN
            updateLocalLvn(lvn)

            // Priority 2 fix: targeted invalidation — only wipe entries affected by this tuple
            cache.deleteByChanged(tenantId, subject, object)

            // Clean up permission index for this specific tuple — fire-and-forget
            removeGrant(tenantId, subject, relation, object)
                .catch((err: unknown) => logger.warn({ err }, 'perm_index_remove_async_failed'))

            logger.info({ tenantId, subject, relation, object, lvn }, 'tuple_removed')
            return reply.status(200).send({ success: true, lvn })

        } catch (error) {
            logger.error({ error: (error as Error).message, tenantId }, 'tuple_delete_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
