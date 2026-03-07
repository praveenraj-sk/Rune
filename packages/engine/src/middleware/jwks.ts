/**
 * JWKS key store — RS256 token verification, zero external dependencies.
 *
 * Caches public keys by `kid` in memory with a 60-second TTL.
 * On a cache miss (unknown kid), re-fetches the JWKS endpoint once —
 * this handles key rotation without requiring a server restart.
 *
 * Uses Node.js built-in crypto only:
 *   - createPublicKey({ key: jwk, format: 'jwk' }) — JWK → KeyObject (Node 16+)
 *   - createVerify('RSA-SHA256') — constant-time RSA signature verify
 *
 * SECURITY:
 * - Public keys only — private keys are never present in a JWKS endpoint
 * - Fetch errors do not fall through to approval: getPublicKey() returns null
 * - TTL prevents stale key abuse while allowing rotation within 60 seconds
 */
import { createPublicKey, createVerify, type KeyObject, type JsonWebKey } from 'crypto'
import { logger } from '../logger/index.js'

const KEY_CACHE = new Map<string, KeyObject>()
const CACHE_TTL_MS = 60_000
let lastFetch = 0

type JwkEntry = {
    kid?: string
    kty: string
    use?: string
    n?: string
    e?: string
    [key: string]: unknown
}

async function fetchAndCache(uri: string): Promise<void> {
    const res = await fetch(uri)
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)

    const data = await res.json() as { keys: JwkEntry[] }
    if (!Array.isArray(data.keys)) throw new Error('JWKS response missing keys array')

    KEY_CACHE.clear()
    for (const jwk of data.keys) {
        if (jwk.kty === 'RSA' && jwk.kid) {
            try {
                KEY_CACHE.set(jwk.kid, createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' }))
            } catch {
                // Skip malformed keys — don't let one bad key block the rest
                logger.warn({ kid: jwk.kid }, 'jwks_key_parse_failed')
            }
        }
    }
    lastFetch = Date.now()
    logger.debug({ uri, keys: KEY_CACHE.size }, 'jwks_keys_refreshed')
}

/**
 * Get the public KeyObject for a given kid.
 * Fetches the JWKS endpoint if cache is stale or kid is unknown.
 * Returns null if the kid is still not found after a fresh fetch.
 */
export async function getPublicKey(uri: string, kid: string): Promise<KeyObject | null> {
    const isStale = Date.now() - lastFetch > CACHE_TTL_MS
    if (isStale || !KEY_CACHE.has(kid)) {
        try {
            await fetchAndCache(uri)
        } catch (err) {
            logger.error({ uri, err: (err as Error).message }, 'jwks_fetch_failed')
            return null
        }
    }
    return KEY_CACHE.get(kid) ?? null
}

/**
 * Verify an RS256 JWT signature using a cached public key.
 * Returns true only if the signature is cryptographically valid.
 */
export function verifyRs256(
    headerB64: string,
    payloadB64: string,
    sigB64: string,
    publicKey: KeyObject,
): boolean {
    try {
        return createVerify('RSA-SHA256')
            .update(`${headerB64}.${payloadB64}`)
            .verify(publicKey, Buffer.from(sigB64, 'base64url'))
    } catch {
        return false
    }
}

/** Exposed for tests — resets the key cache and last-fetch timestamp */
export function _resetJwksCache(): void {
    KEY_CACHE.clear()
    lastFetch = 0
}
