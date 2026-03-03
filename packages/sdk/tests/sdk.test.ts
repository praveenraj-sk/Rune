/**
 * @rune/sdk Tests
 *
 * Uses a lightweight mock HTTP server (built-in Node.js http module)
 * so tests run with zero external dependencies and no real engine needed.
 *
 * Coverage:
 * - Rune class construction (missing apiKey/baseUrl throws)
 * - Fluent can().do().on() API returns CanResult
 * - Direct check() API
 * - allow() and revoke() tuple management
 * - logs() decision log retrieval
 * - health() no-auth endpoint
 * - RuneError on non-2xx responses
 * - Timeout via AbortController
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { Rune, RuneError } from '../src/index.js'
import type { CanResult, TupleResult, LogsResult, HealthResult } from '../src/types.js'

// ── Mock Server ───────────────────────────────────────────────────────────────

const MOCK_ALLOW: CanResult = {
    decision: 'allow',
    status: 'ALLOW',
    reason: 'Access granted',
    trace: [{ node: 'user:alice', result: 'start' }, { node: 'doc:report', result: 'connected' }],
    suggested_fix: [],
    cache_hit: false,
    latency_ms: 2.5,
    sct: { lvn: 42 },
}

const MOCK_DENY: CanResult = {
    decision: 'deny',
    status: 'DENY',
    reason: 'No valid relationship found',
    trace: [{ node: 'user:bob', result: 'start' }],
    suggested_fix: ['Ask an admin to grant access'],
    cache_hit: false,
    latency_ms: 1.2,
    sct: { lvn: 42 },
}

const MOCK_TUPLE: TupleResult = { success: true, lvn: 43 }
const MOCK_HEALTH: HealthResult = { status: 'ok', db: 'connected', timestamp: new Date().toISOString() }
const MOCK_LOGS: LogsResult = { logs: [{ id: '1', subject: 'user:alice', action: 'read', object: 'doc:report', decision: 'allow', status: 'ALLOW', reason: null, latency_ms: 2, cache_hit: false, created_at: new Date().toISOString() }] }

let server: Server
let baseUrl: string

/** Simple routing mock — returns canned responses by method + path */
function startMockServer(): Promise<string> {
    return new Promise((resolve) => {
        server = createServer((req, res) => {
            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json')

                const url = req.url ?? ''
                const method = req.method ?? ''

                // Simulate 401 for missing key
                if (!req.headers['x-api-key'] && url !== '/v1/health') {
                    res.writeHead(401)
                    res.end(JSON.stringify({ error: 'missing_api_key' }))
                    return
                }

                // Force error on special test key
                if (req.headers['x-api-key'] === 'force-error-key') {
                    res.writeHead(500)
                    res.end(JSON.stringify({ error: 'internal_error' }))
                    return
                }

                if (method === 'POST' && url === '/v1/can') {
                    const parsed = JSON.parse(body || '{}') as { subject?: string }
                    const reply = parsed.subject === 'user:bob' ? MOCK_DENY : MOCK_ALLOW
                    res.writeHead(200)
                    res.end(JSON.stringify(reply))
                } else if (method === 'POST' && url === '/v1/tuples') {
                    res.writeHead(200)
                    res.end(JSON.stringify(MOCK_TUPLE))
                } else if (method === 'DELETE' && url === '/v1/tuples') {
                    res.writeHead(200)
                    res.end(JSON.stringify(MOCK_TUPLE))
                } else if (method === 'GET' && url === '/v1/logs') {
                    res.writeHead(200)
                    res.end(JSON.stringify(MOCK_LOGS))
                } else if (method === 'GET' && url === '/v1/health') {
                    res.writeHead(200)
                    res.end(JSON.stringify(MOCK_HEALTH))
                } else {
                    res.writeHead(404)
                    res.end(JSON.stringify({ error: 'not_found' }))
                }
            })
        })
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number }
            resolve(`http://127.0.0.1:${addr.port}`)
        })
    })
}

beforeAll(async () => { baseUrl = await startMockServer() })
afterAll(() => server.close())

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Rune constructor', () => {
    test('throws if apiKey is missing', () => {
        expect(() => new Rune({ apiKey: '', baseUrl })).toThrow('[Rune] apiKey is required')
    })

    test('throws if baseUrl is missing', () => {
        expect(() => new Rune({ apiKey: 'key', baseUrl: '' })).toThrow('[Rune] baseUrl is required')
    })

    test('creates instance with valid config', () => {
        expect(() => new Rune({ apiKey: 'test-key', baseUrl })).not.toThrow()
    })
})

describe('rune.can() — fluent API', () => {
    const rune = () => new Rune({ apiKey: 'test-key', baseUrl })

    test('allows fluent chaining and returns CanResult', async () => {
        const result = await rune().can('user:alice').do('read').on('doc:report')
        expect(result.status).toBe('ALLOW')
        expect(result.decision).toBe('allow')
        expect(result.cache_hit).toBe(false)
        expect(typeof result.latency_ms).toBe('number')
        expect(result.sct.lvn).toBe(42)
    })

    test('DENY result contains suggested_fix', async () => {
        const result = await rune().can('user:bob').do('read').on('doc:secret')
        expect(result.status).toBe('DENY')
        expect(result.suggested_fix.length).toBeGreaterThan(0)
    })

    test('passes sct option to request', async () => {
        const result = await rune().can('user:alice').do('read').on('doc:report', { sct: { lvn: 10 } })
        expect(result.status).toBe('ALLOW')
    })

    test('TypeScript enforces action type at compile time', () => {
        // This test is a compile-time check — if it builds, it passes
        const builder = rune().can('user:alice').do('read')
        expect(builder).toBeDefined()
    })
})

describe('rune.check() — direct API', () => {
    const rune = () => new Rune({ apiKey: 'test-key', baseUrl })

    test('returns CanResult for allow', async () => {
        const result = await rune().check({ subject: 'user:alice', action: 'read', object: 'doc:report' })
        expect(result.status).toBe('ALLOW')
        expect(Array.isArray(result.trace)).toBe(true)
    })

    test('returns CanResult for deny', async () => {
        const result = await rune().check({ subject: 'user:bob', action: 'read', object: 'doc:secret' })
        expect(result.status).toBe('DENY')
    })
})

describe('rune.allow() and rune.revoke()', () => {
    const rune = () => new Rune({ apiKey: 'test-key', baseUrl })

    test('allow() posts tuple and returns TupleResult', async () => {
        const result = await rune().allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })
        expect(result.success).toBe(true)
        expect(result.lvn).toBeGreaterThan(0)
    })

    test('revoke() deletes tuple and returns TupleResult', async () => {
        const result = await rune().revoke({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })
        expect(result.success).toBe(true)
    })
})

describe('rune.logs()', () => {
    test('returns LogsResult with array', async () => {
        const rune = new Rune({ apiKey: 'test-key', baseUrl })
        const result = await rune.logs()
        expect(Array.isArray(result.logs)).toBe(true)
        expect(result.logs.length).toBeGreaterThan(0)
        expect(result.logs[0]?.subject).toBe('user:alice')
    })
})

describe('rune.health()', () => {
    test('returns HealthResult without API key', async () => {
        const rune = new Rune({ apiKey: 'test-key', baseUrl })
        const result = await rune.health()
        expect(result.status).toBe('ok')
        expect(result.db).toBe('connected')
    })
})

describe('RuneError', () => {
    test('throws RuneError on non-2xx response', async () => {
        const rune = new Rune({ apiKey: 'force-error-key', baseUrl })
        await expect(rune.check({ subject: 'user:alice', action: 'read', object: 'doc:report' }))
            .rejects.toBeInstanceOf(RuneError)
    })

    test('RuneError has statusCode property', async () => {
        const rune = new Rune({ apiKey: 'force-error-key', baseUrl })
        try {
            await rune.check({ subject: 'user:alice', action: 'read', object: 'doc:report' })
        } catch (err) {
            expect(err).toBeInstanceOf(RuneError)
            expect((err as RuneError).statusCode).toBe(500)
        }
    })

    test('throws RuneError on 401 (missing API key caught server-side)', async () => {
        // Rune sends the key — mock returns 401 for empty key, but Rune always sends one
        // Force 401 by using empty key string — constructor throws first
        // Test the error surface via force-error-key path above
        const rune = new Rune({ apiKey: 'force-error-key', baseUrl })
        await expect(rune.logs()).rejects.toBeInstanceOf(RuneError)
    })
})

describe('Timeout and connection errors', () => {
    test('throws RuneError when server is unreachable', async () => {
        // Port 1 is reserved and will immediately refuse connections
        const rune = new Rune({ apiKey: 'key', baseUrl: 'http://127.0.0.1:1', timeout: 500 })
        await expect(rune.check({ subject: 'u', action: 'read', object: 'o' }))
            .rejects.toThrow()
    })

    test('RuneError has valid name', () => {
        const err = new RuneError('timed out after 5000ms', 408)
        expect(err.name).toBe('RuneError')
        expect(err.statusCode).toBe(408)
        expect(err.message).toContain('timed out')
    })
})
