/**
 * Admin-only middleware — restricts /admin routes to a designated admin API key.
 *
 * Must run AFTER authMiddleware (which validates the key and sets tenantId).
 * Compares the request key hash against the ADMIN_API_KEY env var hash.
 *
 * Phase 1: env-var-based admin key.
 * Phase 2: DB-backed is_admin flag on api_keys table.
 *
 * If ADMIN_API_KEY is not set, the dashboard is disabled entirely (403 for everyone).
 */
import { createHash, timingSafeEqual } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

export async function adminOnly(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    // If no ADMIN_API_KEY is configured, dashboard is disabled
    if (!config.admin.apiKeyHash) {
        logger.warn({ ip: request.ip }, 'admin_dashboard_disabled')
        await reply.status(403).send({ error: 'admin_dashboard_disabled' })
        return
    }

    const rawKey = request.headers['x-api-key']
    if (!rawKey || typeof rawKey !== 'string') {
        await reply.status(401).send({ error: 'missing_api_key' })
        return
    }

    const keyHash = createHash('sha256').update(rawKey).digest('hex')

    // timingSafeEqual prevents byte-by-byte timing attacks on the hash comparison.
    // Both buffers must be the same length — length check is itself constant-time here
    // since both are always 64-char SHA-256 hex strings.
    const a = Buffer.from(keyHash)
    const b = Buffer.from(config.admin.apiKeyHash ?? '')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        logger.warn({ ip: request.ip }, 'admin_access_denied')
        await reply.status(403).send({ error: 'forbidden' })
        return
    }
}
