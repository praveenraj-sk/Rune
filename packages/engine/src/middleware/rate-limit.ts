/**
 * Rate limiter middleware — TWO layers of protection:
 *
 * 1. PER-API-KEY rate limit (rateLimitMiddleware)
 *    Runs AFTER authMiddleware. Limits per authenticated key (tenant-level).
 *
 * 2. PER-IP rate limit (ipRateLimitMiddleware)
 *    Runs BEFORE auth. Limits per raw IP. Stops brute-force attacks on
 *    /admin/* endpoints and prevents abuse from compromised API keys.
 *
 * Config (env vars):
 *   RATE_LIMIT_MAX        — max requests per window per API key (default: 100)
 *   RATE_LIMIT_WINDOW_MS  — window duration in ms (default: 10000)
 *
 * Memory safety:
 *   A setInterval runs every window duration to clear expired entries,
 *   preventing unbounded Map growth from inactive API keys / IPs.
 *   Max Map size capped at 100,000 entries to prevent DoS via unique IPs.
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

type WindowEntry = {
    count: number
    windowStart: number
}

const MAX_MAP_SIZE = 100_000

const apiKeyCounters = new Map<string, WindowEntry>()
const ipCounters = new Map<string, WindowEntry>()

// IP rate limit: 200 req per window (2x the API key limit — generous for legitimate users)
const IP_MAX_REQUESTS = 200

// Admin rate limit: 20 req per window (strict — admin endpoints are rarely called in bulk)
const ADMIN_MAX_REQUESTS = 20

// ── Periodic cleanup — remove entries that have expired ──────────────────────

const cleanupInterval = setInterval(() => {
    const now = Date.now()
    let removed = 0
    for (const [key, entry] of apiKeyCounters) {
        if (now - entry.windowStart > config.rateLimit.windowMs) {
            apiKeyCounters.delete(key)
            removed++
        }
    }
    for (const [key, entry] of ipCounters) {
        if (now - entry.windowStart > config.rateLimit.windowMs) {
            ipCounters.delete(key)
            removed++
        }
    }
    if (removed > 0) logger.debug({ removed }, 'rate_limit_entries_cleaned')
}, config.rateLimit.windowMs)

// Allow the process to exit even if this interval is still running
cleanupInterval.unref()

// ── Shared check function ────────────────────────────────────────────────────

function checkLimit(
    counters: Map<string, WindowEntry>,
    key: string,
    maxRequests: number,
    windowMs: number,
): boolean {
    // Prevent unbounded Map growth from unique keys (DoS protection)
    if (counters.size > MAX_MAP_SIZE && !counters.has(key)) {
        return false  // reject when map is full and this is a new entry
    }

    const now = Date.now()
    let entry = counters.get(key)

    if (!entry || now - entry.windowStart > windowMs) {
        entry = { count: 1, windowStart: now }
        counters.set(key, entry)
        return true
    }

    entry.count++
    return entry.count <= maxRequests
}

// ── Per-API-Key Middleware (runs AFTER auth) ─────────────────────────────────

export async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const apiKey = request.headers['x-api-key']
    if (!apiKey || typeof apiKey !== 'string') return

    if (!checkLimit(apiKeyCounters, apiKey, config.rateLimit.maxRequests, config.rateLimit.windowMs)) {
        logger.warn({ ip: request.ip }, 'rate_limit_exceeded')
        await reply.status(429).send({ error: 'rate_limit_exceeded' })
    }
}

// ── Per-IP Middleware (runs BEFORE auth — catches unauthenticated abuse) ─────

export async function ipRateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const ip = request.ip
    if (!checkLimit(ipCounters, ip, IP_MAX_REQUESTS, config.rateLimit.windowMs)) {
        logger.warn({ ip }, 'ip_rate_limit_exceeded')
        await reply.status(429).send({ error: 'rate_limit_exceeded' })
    }
}

// ── Admin Rate Limit (stricter — 20 req/window) ─────────────────────────────

export async function adminRateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const ip = request.ip
    const adminKey = `admin:${ip}`
    if (!checkLimit(ipCounters, adminKey, ADMIN_MAX_REQUESTS, config.rateLimit.windowMs)) {
        logger.warn({ ip }, 'admin_rate_limit_exceeded')
        await reply.status(429).send({ error: 'rate_limit_exceeded' })
    }
}
