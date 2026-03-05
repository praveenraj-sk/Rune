/**
 * Rate limiter middleware — sliding window per authenticated API key.
 *
 * IMPORTANT: Must run AFTER authMiddleware so the limit is applied per
 * authenticated key (tenant-level), not per raw IP.
 *
 * Usage in routes:
 *   preHandler: [authMiddleware, rateLimitMiddleware]
 *
 * Config (env vars):
 *   RATE_LIMIT_MAX        — max requests per window (default: 100)
 *   RATE_LIMIT_WINDOW_MS  — window duration in ms (default: 10000)
 *
 * Memory safety:
 *   A setInterval runs every window duration to clear expired entries,
 *   preventing unbounded Map growth from inactive API keys.
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

type WindowEntry = {
    count: number
    windowStart: number
}

const counters = new Map<string, WindowEntry>()

// ── Periodic cleanup — remove entries that have expired ──────────────────────

const cleanupInterval = setInterval(() => {
    const now = Date.now()
    let removed = 0
    for (const [key, entry] of counters) {
        if (now - entry.windowStart > config.rateLimit.windowMs) {
            counters.delete(key)
            removed++
        }
    }
    if (removed > 0) logger.debug({ removed }, 'rate_limit_entries_cleaned')
}, config.rateLimit.windowMs)

// Allow the process to exit even if this interval is still running
cleanupInterval.unref()

// ── Middleware ───────────────────────────────────────────────────────────────

export async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const apiKey = request.headers['x-api-key']
    if (!apiKey || typeof apiKey !== 'string') {
        // authMiddleware already rejected this — let it pass through
        return
    }

    const now = Date.now()
    const { maxRequests, windowMs } = config.rateLimit

    let entry = counters.get(apiKey)

    if (!entry || now - entry.windowStart > windowMs) {
        // New window
        entry = { count: 1, windowStart: now }
        counters.set(apiKey, entry)
        return
    }

    entry.count++

    if (entry.count > maxRequests) {
        logger.warn({ ip: request.ip, count: entry.count }, 'rate_limit_exceeded')
        await reply.status(429).send({ error: 'rate_limit_exceeded' })
        return
    }
}
