/**
 * Route integration tests.
 * Tests HTTP layer end-to-end using Fastify's inject() — no real HTTP port needed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import { LOGISTICS_TENANT, logisticsTuples } from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

const TEST_API_KEY = 'rune-test-key-1234567890'
const INVALID_API_KEY = 'invalid-key-xyz'

const app = createTestApp()

async function insertTuples(tenantId: string, tuples: Array<{ subject: string; relation: string; object: string }>) {
    for (const t of tuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
       VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [tenantId, t.subject, t.relation, t.object]
        )
    }
}

beforeAll(async () => {
    await app.ready()
})

afterAll(async () => {
    await app.close()
})

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    await insertTuples(LOGISTICS_TENANT, logisticsTuples)
})

describe('GET /v1/health', () => {
    test('returns ok and db:connected without any auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/health' })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ status: string; db: string }>()
        expect(body.status).toBe('ok')
        expect(body.db).toBe('connected')
    })
})

describe('Auth Middleware', () => {
    test('returns 401 with no API key', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            payload: { action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(401)
    })

    test('returns 401 with invalid API key', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            headers: { 'x-api-key': INVALID_API_KEY },
            payload: { action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(401)
    })
})

describe('POST /v1/can', () => {
    test('ALLOW: valid user gets 200 with allow decision', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ status: string; decision: string; trace: unknown[] }>()
        expect(body.status).toBe('ALLOW')
        expect(body.decision).toBe('allow')
        expect(body.trace.length).toBeGreaterThan(0)
    })

    test('DENY: unauthorized user gets 200 with deny decision', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:MH001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ status: string }>()
        expect(body.status).toBe('DENY')
    })

    test('400: missing required field "action"', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(400)
    })

    test('400: invalid action value', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { action: 'fly', object: 'shipment:TN001' },  // not in enum
        })
        expect(res.statusCode).toBe(400)
    })
})

describe('POST + DELETE /v1/tuples', () => {
    test('adds a tuple and returns lvn', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/tuples',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:newuser', relation: 'viewer', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ success: boolean; lvn: number }>()
        expect(body.success).toBe(true)
        expect(body.lvn).toBeGreaterThan(0)
    })

    test('write invalidates cache for that tenant', async () => {
        // Prime the cache
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        // Write a new tuple → cache wipe
        await app.inject({
            method: 'POST', url: '/v1/tuples',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', relation: 'viewer', object: 'shipment:NEW001' },
        })
        // Cache for LOGISTICS_TENANT should be wiped
        const key = cache.buildKey(LOGISTICS_TENANT, 'user:arjun', 'shipment:TN001', 'read')
        expect(cache.get(key)).toBeUndefined()
    })

    test('deletes a tuple', async () => {
        const res = await app.inject({
            method: 'DELETE',
            url: '/v1/tuples',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', relation: 'member', object: 'group:chennai_managers' },
        })
        expect(res.statusCode).toBe(200)
    })
})

describe('GET /v1/logs', () => {
    test('returns recent decision logs for the tenant', async () => {
        // Make a decision first
        await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': TEST_API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        const res = await app.inject({
            method: 'GET',
            url: '/v1/logs',
            headers: { 'x-api-key': TEST_API_KEY },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<{ logs: unknown[] }>()
        expect(Array.isArray(body.logs)).toBe(true)
        expect(body.logs.length).toBeGreaterThan(0)
    })
})
