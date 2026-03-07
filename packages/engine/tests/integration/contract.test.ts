/**
 * API Contract Tests — response shape is a public API commitment.
 *
 * Every field in the response schema is tested for presence and type.
 * If a field is renamed, removed, or type-changed, a consumer SDK breaks.
 * This test catches that before the push.
 *
 * Covers:
 *   - POST /v1/can — ALLOW response shape
 *   - POST /v1/can — DENY response shape (includes suggested_fix)
 *   - POST /v1/can — NOT_FOUND response shape
 *   - GET /v1/health — shape
 *   - POST /v1/tuples — shape (returns lvn)
 *   - GET /v1/accessible — shape
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { query } from '../../src/db/client.js'
import { cache } from '../../src/cache/lru.js'
import { LOGISTICS_TENANT, logisticsTuples } from '../fixtures/tuples.js'
import { createTestApp } from '../helpers/test-app.js'

const API_KEY = 'rune-test-key-1234567890'
const app = createTestApp()

beforeAll(async () => { await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
    await query('DELETE FROM tuples WHERE tenant_id = $1', [LOGISTICS_TENANT])
    cache.deleteByTenant(LOGISTICS_TENANT)
    for (const t of logisticsTuples) {
        await query(
            `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
             VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
            [LOGISTICS_TENANT, t.subject, t.relation, t.object]
        )
    }
})

describe('📋 Contract: POST /v1/can — ALLOW', () => {
    test('ALLOW response contains all required fields with correct types', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        // Core decision fields
        expect(body['decision']).toBe('allow')
        expect(body['status']).toBe('ALLOW')
        expect(typeof body['reason']).toBe('string')
        expect(body['reason']).toBeTruthy()

        // Trace must be an array (non-empty on ALLOW)
        expect(Array.isArray(body['trace'])).toBe(true)

        // suggested_fix is empty array on ALLOW
        expect(Array.isArray(body['suggested_fix'])).toBe(true)
        expect((body['suggested_fix'] as unknown[]).length).toBe(0)

        // Performance and caching metadata
        expect(typeof body['latency_ms']).toBe('number')
        expect(body['latency_ms'] as number).toBeGreaterThanOrEqual(0)
        expect(typeof body['cache_hit']).toBe('boolean')

        // SCT token
        expect(typeof body['sct']).toBe('object')
        expect(typeof (body['sct'] as { lvn: number })['lvn']).toBe('number')
    })
})

describe('📋 Contract: POST /v1/can — DENY', () => {
    test('DENY response contains all required fields with correct types', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:MH001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        expect(body['decision']).toBe('deny')
        expect(body['status']).toBe('DENY')
        expect(typeof body['reason']).toBe('string')
        expect(body['reason']).toBeTruthy()
        expect(Array.isArray(body['trace'])).toBe(true)

        // DENY must always include suggested_fix (array, possibly empty but present)
        expect(Array.isArray(body['suggested_fix'])).toBe(true)
        expect(typeof body['latency_ms']).toBe('number')
        expect(typeof body['cache_hit']).toBe('boolean')
        expect(typeof (body['sct'] as { lvn: number })['lvn']).toBe('number')
    })
})

describe('📋 Contract: POST /v1/can — NOT_FOUND', () => {
    test('NOT_FOUND response has status NOT_FOUND and decision deny', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/can',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:arjun', action: 'read', object: 'shipment:GHOST_OBJECT' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        // SDK consumers check status, not decision
        expect(body['status']).toBe('NOT_FOUND')
        expect(body['decision']).toBe('deny')
        expect(Array.isArray(body['suggested_fix'])).toBe(true)
    })
})

describe('📋 Contract: GET /v1/health', () => {
    test('health response has required fields', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/health' })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        expect(typeof body['status']).toBe('string')
        expect(['ok', 'degraded']).toContain(body['status'])
        expect(typeof body['db']).toBe('string')
        expect(typeof body['timestamp']).toBe('string')
    })
})

describe('📋 Contract: POST /v1/tuples', () => {
    test('add tuple returns success and lvn', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/tuples',
            headers: { 'x-api-key': API_KEY },
            payload: { subject: 'user:contract_test', relation: 'viewer', object: 'shipment:TN001' },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        expect(body['success']).toBe(true)
        expect(typeof body['lvn']).toBe('number')
        expect(body['lvn'] as number).toBeGreaterThan(0)
    })
})

describe('📋 Contract: GET /v1/accessible', () => {
    test('accessible response has subject, action, and objects array', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/accessible?subject=user:arjun&action=read',
            headers: { 'x-api-key': API_KEY },
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Record<string, unknown>>()

        expect(body['subject']).toBe('user:arjun')
        expect(body['action']).toBe('read')
        expect(Array.isArray(body['objects'])).toBe(true)
    })

    test('accessible returns 400 when subject is missing', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/accessible?action=read',
            headers: { 'x-api-key': API_KEY },
        })
        expect(res.statusCode).toBe(400)
    })

    test('accessible returns 400 when action is missing', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/accessible?subject=user:arjun',
            headers: { 'x-api-key': API_KEY },
        })
        expect(res.statusCode).toBe(400)
    })
})
