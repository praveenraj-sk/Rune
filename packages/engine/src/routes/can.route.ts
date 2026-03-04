/**
 * POST /v1/can — authorization decision endpoint.
 *
 * SECURITY: subject is NEVER accepted from the request body blindly.
 * Phase 1: subject passed in body for demo flexibility (documented risk).
 * Phase 2: subject resolved from verified session token — never trust client input.
 */
import type { FastifyInstance } from 'fastify'
import { can } from '../engine/can.js'
import { authMiddleware } from '../middleware/auth.js'
import type { CanInput } from '../engine/types.js'

const bodySchema = {
    type: 'object',
    required: ['subject', 'action', 'object'],
    properties: {
        subject: { type: 'string', minLength: 1 },
        action: { type: 'string', minLength: 1 },
        object: { type: 'string', minLength: 1 },
        context: { type: 'object', properties: { time: { type: 'string' } } },
        sct: { type: 'object', properties: { lvn: { type: 'number' } } },
    },
} as const

type CanBody = {
    subject: string
    action: string
    object: string
    context?: { time?: string }
    sct?: { lvn: number }
}

export async function canRoute(fastify: FastifyInstance): Promise<void> {
    fastify.post<{ Body: CanBody }>('/can', {
        preHandler: authMiddleware,
        schema: { body: bodySchema },
    }, async (request, reply) => {
        const body = request.body
        const subject = body.subject

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
