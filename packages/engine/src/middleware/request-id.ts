/**
 * Request ID middleware — assigns a unique ID to every request.
 *
 * If the client sends an `x-request-id` header, we use that (pass-through).
 * Otherwise, we generate a UUID.
 *
 * The ID is:
 * - Attached to request.requestId (Fastify built-in)
 * - Returned in the `x-request-id` response header
 * - Available for logging via request.id
 *
 * WHY: Without request IDs, you can't correlate a client's "permission denied"
 * error with the exact decision log entry on the server. With request IDs,
 * support can say "give me your request ID" and find the exact log row.
 */
import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'

export function registerRequestId(fastify: FastifyInstance): void {
    // Generate or pass through request ID
    fastify.addHook('onRequest', async (request, reply) => {
        const clientId = request.headers['x-request-id']
        const requestId = (typeof clientId === 'string' && clientId.length > 0)
            ? clientId
            : randomUUID()

        // Fastify's built-in request.id
        request.id = requestId

        // Echo back in response header
        void reply.header('x-request-id', requestId)
    })
}
