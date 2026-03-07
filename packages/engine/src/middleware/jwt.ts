/**
 * JWT Bearer token middleware — HS256 (shared secret) and RS256 (JWKS) support.
 * Zero external dependencies — pure Node.js crypto only.
 *
 * Validates: Authorization: Bearer <token>
 * Requires JWT payload claims:
 *   - sub  (string) — the Rune subject, e.g. "user:alice"
 *   - tid  (string) — the Rune tenant_id
 *   - exp  (number) — expiry (Unix seconds); token rejected if expired
 *
 * Algorithm routing (checked from JWT header `alg` claim):
 *   - HS256 → JWT_SECRET env var must be set (existing behaviour, unchanged)
 *   - RS256 → JWKS_URI env var must be set (Auth0, Cognito, Okta, Keycloak, etc.)
 *   - anything else → 401 (no alg confusion attacks)
 *
 * Sets on request:
 *   - request.tenantId   (from tid claim)
 *   - request.jwtSubject (from sub claim)
 *
 * SECURITY:
 * - HS256: timingSafeEqual prevents byte-by-byte timing attacks
 * - RS256: public key from JWKS; private key never leaves the IdP
 * - Expiry is mandatory — tokens without exp are always rejected
 * - Alg in header must match what's configured — no alg:none, no HS/RS confusion
 * - Raw token is never logged
 */
import { createHmac, timingSafeEqual } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'
import { getPublicKey, verifyRs256 } from './jwks.js'

// Extend FastifyRequest to carry the JWT subject after auth
declare module 'fastify' {
    interface FastifyRequest {
        jwtSubject?: string
    }
}

function base64urlDecode(str: string): Buffer {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function extractClaims(payloadB64: string): { sub: string; tid: string } | null {
    try {
        const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8')) as Record<string, unknown>
        if (typeof payload['exp'] !== 'number') return null
        if (Math.floor(Date.now() / 1000) > payload['exp']) return null
        if (typeof payload['sub'] !== 'string' || !payload['sub']) return null
        if (typeof payload['tid'] !== 'string' || !payload['tid']) return null
        return { sub: payload['sub'], tid: payload['tid'] }
    } catch {
        return null
    }
}

/**
 * Verify a HS256 JWT and return { sub, tid } claims, or null if invalid.
 * Pure Node.js — no external packages.
 */
export function verifyJwt(token: string): { sub: string; tid: string } | null {
    const secret = config.auth.jwtSecret
    if (!secret) return null

    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

    // Recompute expected signature
    const expected = createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url')

    // Timing-safe comparison — prevents byte-by-byte timing attacks
    if (expected.length !== sigB64.length) return null
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64))) return null

    return extractClaims(payloadB64)
}

export async function jwtMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        await reply.status(401).send({ error: 'missing_bearer_token' })
        return
    }

    const token = authHeader.slice(7)
    const parts = token.split('.')
    if (parts.length !== 3) {
        await reply.status(401).send({ error: 'invalid_token' })
        return
    }

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

    // Parse header to determine algorithm — reject anything not explicitly configured
    let header: Record<string, unknown>
    try {
        header = JSON.parse(base64urlDecode(headerB64).toString('utf-8')) as Record<string, unknown>
    } catch {
        await reply.status(401).send({ error: 'invalid_token' })
        return
    }

    const alg = header['alg']

    // ── RS256 path: JWKS_URI configured ─────────────────────────────────────
    if (alg === 'RS256') {
        const jwksUri = config.auth.jwksUri
        if (!jwksUri) {
            logger.warn({ ip: request.ip }, 'jwks_not_configured')
            await reply.status(401).send({ error: 'jwt_not_configured' })
            return
        }

        const kid = typeof header['kid'] === 'string' ? header['kid'] : ''
        const publicKey = await getPublicKey(jwksUri, kid)
        if (!publicKey) {
            logger.warn({ ip: request.ip, kid }, 'jwks_key_not_found')
            await reply.status(401).send({ error: 'invalid_token' })
            return
        }

        if (!verifyRs256(headerB64, payloadB64, sigB64, publicKey)) {
            logger.warn({ ip: request.ip }, 'jwt_rs256_signature_invalid')
            await reply.status(401).send({ error: 'invalid_token' })
            return
        }

        const claims = extractClaims(payloadB64)
        if (!claims) {
            logger.warn({ ip: request.ip }, 'jwt_invalid_claims')
            await reply.status(401).send({ error: 'invalid_token' })
            return
        }

        request.tenantId = claims.tid
        request.jwtSubject = claims.sub
        return
    }

    // ── HS256 path: JWT_SECRET configured ────────────────────────────────────
    if (alg === 'HS256') {
        if (!config.auth.jwtSecret) {
            logger.warn({ ip: request.ip }, 'jwt_not_configured')
            await reply.status(401).send({ error: 'jwt_not_configured' })
            return
        }

        const claims = verifyJwt(token)
        if (!claims) {
            logger.warn({ ip: request.ip }, 'jwt_invalid_token')
            await reply.status(401).send({ error: 'invalid_token' })
            return
        }

        request.tenantId = claims.tid
        request.jwtSubject = claims.sub
        return
    }

    // ── Unknown / unsupported algorithm ──────────────────────────────────────
    // Explicitly reject alg:none and any other algorithm (PS256, EdDSA, etc.)
    // to prevent algorithm confusion attacks.
    logger.warn({ ip: request.ip, alg }, 'jwt_unsupported_algorithm')
    await reply.status(401).send({ error: 'invalid_token' })
}
