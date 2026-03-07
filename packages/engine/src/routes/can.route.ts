/**
 * POST /v1/can — authorization decision endpoint.
 *
 * Auth: accepts either x-api-key (API key) or Authorization: Bearer <jwt> (JWT).
 *
 * SECURITY: when authenticated via JWT, the subject is resolved from the
 * verified token's `sub` claim — the request body subject is ignored.
 * This is the Phase 2 behaviour delivered early: zero client trust when using JWT.
 *
 * Phase 1 legacy: when using API key auth, subject still comes from the body
 * (documented risk — body is trusted because server-to-server calls know what they're doing).
 */
import type { FastifyInstance } from 'fastify'
import { can } from '../engine/can.js'
import { apiKeyOrJwtMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import type { CanInput } from '../engine/types.js'

const bodySchema = {
    type: 'object',
    required: ['action', 'object'],
    properties: {
        // subject is optional when using JWT auth — resolved from token's sub claim
        subject: { type: 'string', minLength: 1 },
        action: { type: 'string', minLength: 1 },
        object: { type: 'string', minLength: 1 },
        context: { type: 'object', properties: { time: { type: 'string' } } },
        sct: { type: 'object', properties: { lvn: { type: 'number' } } },
    },
} as const

type CanBody = {
    subject?: string
    action: string
    object: string
    context?: { time?: string }
    sct?: { lvn: number }
}

export async function canRoute(fastify: FastifyInstance): Promise<void> {
    fastify.post<{ Body: CanBody }>('/can', {
        preHandler: [apiKeyOrJwtMiddleware, rateLimitMiddleware],
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const body = request.body

        // JWT auth: subject from verified token (jwtSubject) — body subject is ignored.
        // API key auth: subject from body (server-to-server, trusted caller).
        const subject = request.jwtSubject ?? body.subject
        if (!subject) {
            return reply.status(400).send({ error: 'subject required (or use JWT auth with sub claim)' })
        }

        // Build input without undefined fields (exactOptionalPropertyTypes)
        const input: CanInput = {
            subject,
            action: body.action,
            object: body.object,
            tenantId: request.tenantId,
        }
        if (body.context) input.context = body.context
        if (body.sct) input.sct = body.sct

        const result = await can(input)
        return reply.status(200).send(result)
    })
}
