/**
 * Shared Fastify error handler.
 * Used in server.ts (production) and all test apps (consistency).
 *
 * Never exposes stack traces or internal error details.
 */
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { logger } from '../logger/index.js'

export function errorHandler(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
): void {
    logger.error({ error: error.message, statusCode: error.statusCode }, 'request_error')

    if (error.statusCode === 400) {
        void reply.status(400).send({ error: 'validation_error', details: error.message })
        return
    }

    void reply.status(error.statusCode ?? 500).send({ error: 'internal_error' })
}
