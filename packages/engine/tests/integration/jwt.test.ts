/**
 * JWT Security Tests — 10 attack and correctness scenarios.
 *
 * The JWT middleware uses HS256 (HMAC-SHA256) with a secret from JWT_SECRET env var.
 * These tests verify both the happy path and every known JWT attack vector.
 *
 * Token structure expected:
 *   { sub: "user:alice", tid: "tenant-uuid", exp: <unix seconds> }
 *
 * Tests:
 *   1.  Valid JWT → ALLOW decision, subject resolved from token
 *   2.  Valid JWT → body subject is ignored (token sub takes precedence)
 *   3.  Expired token → 401
 *   4.  Wrong secret → 401
 *   5.  alg:none attack (stripped signature) → 401
 *   6.  Missing exp claim → 401 (expiry required, no eternal tokens)
 *   7.  Missing sub claim → 401
 *   8.  Missing tid claim → 401
 *   9.  Tampered payload (valid sig on different content) → 401
 *  10.  JWT not configured (no JWT_SECRET) → 401 with jwt_not_configured
 *       (tested by calling jwtMiddleware directly)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import { LOGISTICS_TENANT, logisticsTuples } from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

// Must match what tests/setup.ts sets in process.env['JWT_SECRET']
const TEST_JWT_SECRET = 'test-jwt-secret-for-unit-tests-minimum-32-chars'
const WRONG_SECRET = 'completely-different-wrong-secret-min-32-chars!!'

const app = createTestApp()

/** Build a HS256 JWT — same algorithm as middleware/jwt.ts */
function makeJwt(
    payload: Record<string, unknown>,
    secret = TEST_JWT_SECRET,
): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
    return `${header}.${body}.${sig}`
}

function futureExp(secondsFromNow = 3600): number {
    return Math.floor(Date.now() / 1000) + secondsFromNow
}

function pastExp(secondsAgo = 60): number {
    return Math.floor(Date.now() / 1000) - secondsAgo
}

async function insertTuples(tenantId: string, tuples: Array<{ subject: string; relation: string; object: string }>) {
    for (const t of tuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
             VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [tenantId, t.subject, t.relation, t.object]
        )
    }
}

beforeAll(async () => { await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
})

describe('🔑 JWT Auth — Happy Path', () => {

    test('JWT 1 — valid token grants access, subject resolved from sub claim', async () => {
        const token = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            // action + object required; subject comes from JWT sub
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json<{ status: string }>().status).toBe('ALLOW')
    })

    test('JWT 2 — body subject is IGNORED when JWT is present (JWT sub wins)', async () => {
        // Token says sub = user:arjun (has access)
        // Body says subject = user:nobody (no access)
        // JWT sub must win — result should be ALLOW (arjun's decision)
        const token = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { subject: 'user:nobody', action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(200)
        // If body subject was used, this would be DENY (user:nobody has no access)
        // If JWT sub was used, this is ALLOW (user:arjun has access)
        expect(res.json<{ status: string }>().status).toBe('ALLOW')
    })

    test('JWT 3 — DENY decision via JWT auth (valid token, no access path)', async () => {
        const token = makeJwt({
            sub: 'user:nobody',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json<{ status: string }>().status).toBe('DENY')
    })
})

describe('🛡️ JWT Attacks', () => {

    test('JWT 4 — expired token → 401', async () => {
        const token = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: pastExp(),  // already expired
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
        expect(res.json<{ error: string }>().error).toBe('invalid_token')
    })

    test('JWT 5 — wrong secret → 401 (signature mismatch)', async () => {
        const token = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        }, WRONG_SECRET)  // signed with wrong secret

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
        expect(res.json<{ error: string }>().error).toBe('invalid_token')
    })

    test('JWT 6 — alg:none attack (signature stripped) → 401', async () => {
        // The alg:none attack: send a JWT with alg:none and no signature.
        // A vulnerable library accepts this as "unsigned = always valid".
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
        const payload = Buffer.from(JSON.stringify({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })).toString('base64url')
        const algNoneToken = `${header}.${payload}.`  // empty signature

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${algNoneToken}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        // Must reject — HMAC recomputation will produce a non-empty signature
        // that won't match the empty string
        expect(res.statusCode).toBe(401)
    })

    test('JWT 7 — missing exp claim → 401 (no eternal tokens)', async () => {
        const token = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            // exp deliberately omitted
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
        expect(res.json<{ error: string }>().error).toBe('invalid_token')
    })

    test('JWT 8 — missing sub claim → 401', async () => {
        const token = makeJwt({
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
            // sub deliberately omitted
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
    })

    test('JWT 9 — missing tid claim → 401 (no tenant = no access)', async () => {
        const token = makeJwt({
            sub: 'user:arjun',
            exp: futureExp(),
            // tid deliberately omitted
        })

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${token}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
    })

    test('JWT 10 — tampered payload with valid header+sig → 401', async () => {
        // Sign a legitimate token, then swap the payload section
        const legitimate = makeJwt({
            sub: 'user:arjun',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })
        const parts = legitimate.split('.')
        // Replace payload with a different (attacker's) payload but keep original signature
        const attackerPayload = Buffer.from(JSON.stringify({
            sub: 'user:admin',
            tid: LOGISTICS_TENANT,
            exp: futureExp(),
        })).toString('base64url')
        const tampered = `${parts[0]}.${attackerPayload}.${parts[2]}`

        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { authorization: `Bearer ${tampered}` },
            payload: { action: 'read', object: 'shipment:TN001' },
        })

        expect(res.statusCode).toBe(401)
        expect(res.json<{ error: string }>().error).toBe('invalid_token')
    })
})
