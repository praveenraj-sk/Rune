/**
 * SDK cache strategy tests — @runeauth/sdk
 *
 * Verifies that CacheStrategy controls read/write behavior:
 *   allow_and_deny — both ALLOW + DENY cached (default)
 *   deny_only      — DENY cached; ALLOW always hits server
 *   none           — nothing cached; every check goes to server
 *
 * Uses vi.fn() to mock fetch so no real engine is needed.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { RuneClient } from '../src/client.js'

// ─── Mock fetch globally ──────────────────────────────────────────────────────
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function allowResponse(lvn = 1) {
    return {
        ok: true,
        json: async () => ({
            decision: 'allow', status: 'ALLOW', reason: 'direct access',
            trace: [], suggested_fix: [], cache_hit: false, index_hit: false,
            latency_ms: 2, sct: { lvn },
        }),
    }
}

function denyResponse(lvn = 1) {
    return {
        ok: true,
        json: async () => ({
            decision: 'deny', status: 'DENY', reason: 'no path',
            trace: [], suggested_fix: [], cache_hit: false, index_hit: false,
            latency_ms: 2, sct: { lvn },
        }),
    }
}

function makeClient(strategy: 'allow_and_deny' | 'deny_only' | 'none') {
    return new RuneClient({
        apiKey: 'rune_test',
        baseUrl: 'http://localhost:4078',
        retry: false,
        circuitBreaker: false,
        cache: { strategy, ttl: 60_000, maxSize: 100 },
    })
}

const CHECK_PARAMS = { subject: 'user:A', action: 'read', object: 'doc:1' }

beforeEach(() => {
    mockFetch.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function checkCacheBehavior(client: ReturnType<typeof makeClient>, type: 'allow' | 'deny', expectHit: boolean, expectedFetchCount: number) {
    const r1 = await client.check(CHECK_PARAMS)
    const r2 = await client.check(CHECK_PARAMS)

    expect(r1.decision).toBe(type)
    expect(r2.decision).toBe(type)
    expect(r2.cache_hit).toBe(expectHit)
    expect(mockFetch).toHaveBeenCalledTimes(expectedFetchCount)
}

// ─────────────────────────────────────────────────────────────────────────────
// allow_and_deny (default)
// ─────────────────────────────────────────────────────────────────────────────
describe('CacheStrategy: allow_and_deny', () => {
    test('caches ALLOW — second call does not hit server', async () => {
        mockFetch.mockResolvedValue(allowResponse())
        await checkCacheBehavior(makeClient('allow_and_deny'), 'allow', true, 1)
    })

    test('caches DENY — second call does not hit server', async () => {
        mockFetch.mockResolvedValue(denyResponse())
        await checkCacheBehavior(makeClient('allow_and_deny'), 'deny', true, 1)
    })

    test('cache is cleared after revoke()', async () => {
        // Allow then revoke
        mockFetch
            .mockResolvedValueOnce(allowResponse())               // check #1
            .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, lvn: 2 }) }) // revoke
            .mockResolvedValueOnce(denyResponse(2))               // check #2

        const client = makeClient('allow_and_deny')

        const r1 = await client.check(CHECK_PARAMS)
        expect(r1.decision).toBe('allow')

        await client.revoke({ subject: 'user:A', relation: 'viewer', object: 'doc:1' })

        const r2 = await client.check(CHECK_PARAMS)
        expect(r2.decision).toBe('deny')
        expect(r2.cache_hit).toBe(false)
        expect(mockFetch).toHaveBeenCalledTimes(3)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// deny_only — DENY cached, ALLOW always re-fetched
// ─────────────────────────────────────────────────────────────────────────────
describe('CacheStrategy: deny_only', () => {
    test('does NOT cache ALLOW — every ALLOW hits the server', async () => {
        mockFetch.mockResolvedValue(allowResponse())
        const client = makeClient('deny_only')

        await client.check(CHECK_PARAMS)
        await client.check(CHECK_PARAMS)
        await client.check(CHECK_PARAMS)

        expect(mockFetch).toHaveBeenCalledTimes(3) // every call hits server
    })

    test('DOES cache DENY — second DENY does not hit server', async () => {
        mockFetch.mockResolvedValue(denyResponse())
        await checkCacheBehavior(makeClient('deny_only'), 'deny', true, 1)
    })

    test('access revocation is seen immediately — no stale ALLOW window', async () => {
        // Server first returns ALLOW, then DENY after revocation
        mockFetch
            .mockResolvedValueOnce(allowResponse(1))
            .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, lvn: 2 }) }) // revoke
            .mockResolvedValueOnce(denyResponse(2))

        const client = makeClient('deny_only')

        const r1 = await client.check(CHECK_PARAMS) // ALLOW — not cached
        expect(r1.decision).toBe('allow')

        await client.revoke({ subject: 'user:A', relation: 'viewer', object: 'doc:1' })

        const r2 = await client.check(CHECK_PARAMS) // must see DENY immediately
        expect(r2.decision).toBe('deny')
        expect(mockFetch).toHaveBeenCalledTimes(3)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// none — no client-side caching at all
// ─────────────────────────────────────────────────────────────────────────────
describe('CacheStrategy: none', () => {
    test('every ALLOW request hits the server (zero caching)', async () => {
        mockFetch.mockResolvedValue(allowResponse())
        const client = makeClient('none')

        for (let i = 0; i < 5; i++) await client.check(CHECK_PARAMS)

        expect(mockFetch).toHaveBeenCalledTimes(5)
    })

    test('every DENY request hits the server (zero caching)', async () => {
        mockFetch.mockResolvedValue(denyResponse())
        const client = makeClient('none')

        for (let i = 0; i < 5; i++) await client.check(CHECK_PARAMS)

        expect(mockFetch).toHaveBeenCalledTimes(5)
    })

    test('revocation immediately effective — no stale window possible', async () => {
        // First 2 calls ALLOW; after "revoke" 3rd call sees DENY
        mockFetch
            .mockResolvedValueOnce(allowResponse())
            .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, lvn: 2 }) })
            .mockResolvedValueOnce(denyResponse(2))

        const client = makeClient('none')
        const r1 = await client.check(CHECK_PARAMS)
        expect(r1.decision).toBe('allow')

        await client.revoke({ subject: 'user:A', relation: 'viewer', object: 'doc:1' })

        const r2 = await client.check(CHECK_PARAMS)
        expect(r2.decision).toBe('deny')
        expect(r2.cache_hit).toBe(false)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// SCT token bypasses stale cache
// ─────────────────────────────────────────────────────────────────────────────
describe('SCT token integration', () => {
    test('passing newer SCT bypasses stale cached ALLOW', async () => {
        // First call caches ALLOW at lvn:1
        mockFetch.mockResolvedValueOnce(allowResponse(1))
        const client = makeClient('allow_and_deny')

        const r1 = await client.check({ ...CHECK_PARAMS, sct: { lvn: 0 } })
        expect(r1.decision).toBe('allow')
        expect(r1.cache_hit).not.toBe(true) // server response — not a cache hit

        // Second call with higher LVN — cache entry is stale, must re-fetch
        mockFetch.mockResolvedValueOnce(denyResponse(5))
        const r2 = await client.check({ ...CHECK_PARAMS, sct: { lvn: 5 } })
        expect(r2.decision).toBe('deny')
        expect(mockFetch).toHaveBeenCalledTimes(2) // forced re-fetch
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// No-cache config (cache: false)
// ─────────────────────────────────────────────────────────────────────────────
describe('cache disabled (cache: false)', () => {
    test('no caching when cache option is false', async () => {
        mockFetch.mockResolvedValue(allowResponse())
        const client = new RuneClient({
            apiKey: 'rune_test',
            baseUrl: 'http://localhost:4078',
            cache: false,
            retry: false,
            circuitBreaker: false,
        })

        await client.check(CHECK_PARAMS)
        await client.check(CHECK_PARAMS)

        expect(mockFetch).toHaveBeenCalledTimes(2)
    })
})
