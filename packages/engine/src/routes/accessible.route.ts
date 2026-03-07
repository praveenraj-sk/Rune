/**
 * GET /v1/accessible — list all objects a subject can perform an action on.
 *
 * Queries the materialised permission_index — O(1) indexed lookup.
 * No BFS traversal needed; the index is maintained on every tuple write.
 *
 * Auth: accepts either x-api-key or Authorization: Bearer <jwt>.
 * When using JWT, subject defaults to the token's sub claim if not provided.
 *
 * Query params:
 *   subject  (string) — e.g. "user:alice"  (optional when using JWT auth)
 *   action   (string) — e.g. "read"
 *
 * Response:
 *   { subject, action, objects: string[] }
 *
 * Use case: populate a list/table in your UI showing only resources the
 * current user can see, without fetching everything and filtering in-app.
 *
 * @example
 * GET /v1/accessible?subject=user:alice&action=read
 * → { subject: "user:alice", action: "read", objects: ["doc:readme", "doc:spec"] }
 */
import type { FastifyInstance } from 'fastify'
import { apiKeyOrJwtMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'

export async function accessibleRoute(fastify: FastifyInstance): Promise<void> {
    fastify.get<{
        Querystring: { subject?: string; action?: string }
    }>('/accessible', {
        preHandler: [apiKeyOrJwtMiddleware, rateLimitMiddleware],
    }, async (request, reply) => {
        const tenantId = request.tenantId

        // JWT auth: subject from token; API key auth: subject from query param
        const subject = (request.jwtSubject ?? request.query.subject)?.trim()
        const action = request.query.action?.trim()

        if (!subject) {
            return reply.status(400).send({ error: 'subject query param required (or use JWT auth with sub claim)' })
        }
        if (!action) {
            return reply.status(400).send({ error: 'action query param required' })
        }

        try {
            const result = await query<{ object: string }>(
                `SELECT object
                 FROM   permission_index
                 WHERE  tenant_id = $1
                   AND  subject   = $2
                   AND  action    = $3
                 ORDER BY object`,
                [tenantId, subject, action],
            )

            return reply.status(200).send({
                subject,
                action,
                objects: result.rows.map(r => r.object),
            })
        } catch (err) {
            logger.error({ err, tenantId, subject, action }, 'accessible_query_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })
}
