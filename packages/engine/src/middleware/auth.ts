/**
 * API key authentication middleware.
 *
 * Reads x-api-key header, hashes it with SHA-256, looks up in api_keys table.
 * Attaches tenant_id to request on success.
 *
 * SECURITY:
 * - Raw key is never stored or logged — only the hash
 * - Missing or invalid key → 401 (fail closed)
 * - Any DB error → 401 (fail closed)
 */
import { createHash } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'
import { jwtMiddleware } from './jwt.js'

// Extend FastifyRequest to carry tenantId after auth
declare module 'fastify' {
    interface FastifyRequest {
        tenantId: string
    }
}

export async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const rawKey = request.headers['x-api-key']

    if (!rawKey || typeof rawKey !== 'string') {
        logger.warn({ ip: request.ip }, 'auth_missing_api_key')
        await reply.status(401).send({ error: 'missing_api_key' })
        return
    }

    const keyHash = createHash('sha256').update(rawKey).digest('hex')

    try {
        const result = await query<{ tenant_id: string; id: string }>(
            `SELECT id, tenant_id FROM api_keys WHERE key_hash = $1`,
            [keyHash]
        )

        if ((result.rowCount ?? 0) === 0) {
            logger.warn({ ip: request.ip }, 'auth_invalid_api_key')
            await reply.status(401).send({ error: 'invalid_api_key' })
            return
        }

        const row = result.rows[0]
        if (!row) {
            await reply.status(401).send({ error: 'invalid_api_key' })
            return
        }

        request.tenantId = row.tenant_id

        // Update last_used — fire and forget (failure does not affect auth)
        query(
            `UPDATE api_keys SET last_used = now() WHERE id = $1`,
            [row.id]
        ).catch((err: unknown) => logger.error({ err }, 'api_key_last_used_update_failed'))

    } catch (error) {
        logger.error({ error: (error as Error).message }, 'auth_middleware_db_error')
        await reply.status(401).send({ error: 'auth_error' })
    }
}

/**
 * Combined auth middleware — accepts either:
 *   1. x-api-key header  → API key auth (existing behaviour, unchanged)
 *   2. Authorization: Bearer <jwt>  → JWT HS256 auth (requires JWT_SECRET env var)
 *
 * Used on endpoints where end-user clients may call Rune directly with a
 * short-lived JWT instead of a long-lived API key.
 */
export async function apiKeyOrJwtMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    if (request.headers['x-api-key']) {
        return authMiddleware(request, reply)
    }
    if (request.headers.authorization?.startsWith('Bearer ')) {
        return jwtMiddleware(request, reply)
    }
    await reply.status(401).send({ error: 'missing_credentials' })
}
