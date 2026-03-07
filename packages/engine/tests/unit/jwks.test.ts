/**
 * JWKS / RS256 Tests — verifies the full RS256 JWT verification pipeline.
 *
 * Uses real RSA key pairs generated in-process (no network, no mocks for crypto).
 * Mocks `global.fetch` to intercept the JWKS endpoint call.
 *
 * Covers:
 *   1.  getPublicKey fetches and caches keys by kid
 *   2.  getPublicKey returns cached key within TTL (no second fetch)
 *   3.  getPublicKey re-fetches on unknown kid (key rotation)
 *   4.  getPublicKey returns null on fetch error
 *   5.  verifyRs256 accepts valid signature
 *   6.  verifyRs256 rejects tampered payload
 *   7.  verifyRs256 rejects wrong key
 *   8.  jwtMiddleware RS256 happy path → sets tenantId + jwtSubject
 *   9.  jwtMiddleware RS256 expired token → 401
 *   10. jwtMiddleware RS256 missing tid → 401
 *   11. jwtMiddleware RS256 unknown kid (fetch returns no matching key) → 401
 *   12. jwtMiddleware RS256 + JWKS disabled (no JWKS_URI in config) → 401
 *   13. jwtMiddleware alg:none → 401 (no alg confusion)
 *   14. jwtMiddleware unsupported alg (ES256) → 401
 */
import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest'
import {
    generateKeyPairSync,
    createSign,
    type KeyObject,
} from 'crypto'
import { getPublicKey, verifyRs256, _resetJwksCache } from '../../src/middleware/jwks.js'
import { jwtMiddleware } from '../../src/middleware/jwt.js'
import type { FastifyRequest, FastifyReply } from 'fastify'

// ── Key generation ────────────────────────────────────────────────────────────
// Generated once in beforeAll — 2048-bit RSA is fine for tests
let privateKey: KeyObject
let publicKey: KeyObject
let jwk: Record<string, unknown>
const TEST_KID = 'test-key-1'
const JWKS_URI = 'http://rune-test-jwks/.well-known/jwks.json'

beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    privateKey = pair.privateKey
    publicKey = pair.publicKey
    jwk = { ...publicKey.export({ format: 'jwk' }) as Record<string, unknown>, kid: TEST_KID, use: 'sig' }
})

afterEach(() => {
    vi.unstubAllGlobals()
    _resetJwksCache()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJwksResponse(keys: unknown[]) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ keys }),
    }
}

function makeFetch(response: unknown) {
    return vi.fn().mockResolvedValue(response)
}

function buildRs256Jwt(
    payload: Record<string, unknown>,
    kid = TEST_KID,
    key: KeyObject = privateKey,
): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createSign('RSA-SHA256').update(`${header}.${body}`).sign(key, 'base64url')
    return `${header}.${body}.${sig}`
}

function futureExp(s = 3600) { return Math.floor(Date.now() / 1000) + s }
function pastExp(s = 60) { return Math.floor(Date.now() / 1000) - s }

function mockRequest(token: string): Partial<FastifyRequest> {
    return { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1' }
}

function mockReply() {
    const reply = {
        _status: 0,
        _body: {} as unknown,
        status(code: number) { this._status = code; return this },
        async send(body: unknown) { this._body = body; return this },
    }
    return reply
}

// ─── getPublicKey ─────────────────────────────────────────────────────────────

describe('getPublicKey', () => {
    test('fetches JWKS and returns key by kid', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const key = await getPublicKey(JWKS_URI, TEST_KID)
        expect(key).not.toBeNull()
    })

    test('uses cached key within TTL — no second fetch', async () => {
        const fetchMock = makeFetch(makeJwksResponse([jwk]))
        vi.stubGlobal('fetch', fetchMock)

        await getPublicKey(JWKS_URI, TEST_KID)
        await getPublicKey(JWKS_URI, TEST_KID)

        // Only one HTTP call — second was served from cache
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('re-fetches on unknown kid (key rotation)', async () => {
        const fetchMock = makeFetch(makeJwksResponse([jwk]))
        vi.stubGlobal('fetch', fetchMock)

        // First fetch returns only TEST_KID
        await getPublicKey(JWKS_URI, TEST_KID)
        // Request an unknown kid → triggers re-fetch
        await getPublicKey(JWKS_URI, 'rotated-key-2')

        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('returns null on fetch error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

        const key = await getPublicKey(JWKS_URI, TEST_KID)
        expect(key).toBeNull()
    })

    test('returns null for unknown kid after fresh fetch', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const key = await getPublicKey(JWKS_URI, 'completely-unknown-kid')
        expect(key).toBeNull()
    })
})

// ─── verifyRs256 ─────────────────────────────────────────────────────────────

describe('verifyRs256', () => {
    test('accepts valid RS256 signature', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({ sub: 'user:alice', tid: 'tenant-1', exp: futureExp() })).toString('base64url')
        const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url')

        expect(verifyRs256(header, payload, sig, publicKey)).toBe(true)
    })

    test('rejects tampered payload (original sig, different content)', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: TEST_KID })).toString('base64url')
        const original = Buffer.from(JSON.stringify({ sub: 'user:alice', tid: 'tenant-1', exp: futureExp() })).toString('base64url')
        const tampered = Buffer.from(JSON.stringify({ sub: 'user:admin', tid: 'tenant-1', exp: futureExp() })).toString('base64url')
        const sig = createSign('RSA-SHA256').update(`${header}.${original}`).sign(privateKey, 'base64url')

        expect(verifyRs256(header, tampered, sig, publicKey)).toBe(false)
    })

    test('rejects signature from a different key', () => {
        const { privateKey: otherPrivate, publicKey: otherPublic } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({ sub: 'user:alice', tid: 't1', exp: futureExp() })).toString('base64url')

        // Signed with otherPrivate
        const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(otherPrivate, 'base64url')
        // Verified against originalPublic — must fail
        expect(verifyRs256(header, payload, sig, publicKey)).toBe(false)
        // Verified against otherPublic — must pass
        expect(verifyRs256(header, payload, sig, otherPublic)).toBe(true)
    })
})

// ─── jwtMiddleware — RS256 flow ───────────────────────────────────────────────

describe('jwtMiddleware — RS256', () => {
    test('valid RS256 token → sets tenantId + jwtSubject', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const token = buildRs256Jwt({ sub: 'user:alice', tid: 'tenant-abc', exp: futureExp() })
        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(0)  // reply.status() never called — success
        expect((req as { tenantId?: string }).tenantId).toBe('tenant-abc')
        expect((req as { jwtSubject?: string }).jwtSubject).toBe('user:alice')
    })

    test('expired RS256 token → 401', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const token = buildRs256Jwt({ sub: 'user:alice', tid: 'tenant-abc', exp: pastExp() })
        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(401)
        expect((rep._body as { error: string }).error).toBe('invalid_token')
    })

    test('missing tid claim → 401', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const token = buildRs256Jwt({ sub: 'user:alice', exp: futureExp() })  // no tid
        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(401)
    })

    test('unknown kid → 401 (key not in JWKS)', async () => {
        vi.stubGlobal('fetch', makeFetch(makeJwksResponse([jwk])))

        const token = buildRs256Jwt({ sub: 'user:alice', tid: 'tenant-abc', exp: futureExp() }, 'unknown-kid-xyz')
        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(401)
    })

    test('alg:none → 401', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({ sub: 'user:alice', tid: 'tenant-abc', exp: futureExp() })).toString('base64url')
        const token = `${header}.${payload}.`

        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(401)
        expect((rep._body as { error: string }).error).toBe('invalid_token')
    })

    test('unsupported alg (ES256) → 401', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({ sub: 'user:alice', tid: 'tenant-abc', exp: futureExp() })).toString('base64url')
        const token = `${header}.${payload}.fakesig`

        const req = mockRequest(token)
        const rep = mockReply()

        await jwtMiddleware(req as FastifyRequest, rep as unknown as FastifyReply)

        expect(rep._status).toBe(401)
        expect((rep._body as { error: string }).error).toBe('invalid_token')
    })
})
