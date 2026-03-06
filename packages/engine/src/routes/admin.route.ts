/**
 * Admin Dashboard route — serves the dashboard at /admin
 * Modular: HTML, CSS, JS served as separate files.
 *
 * Protected by [authMiddleware, adminOnly]:
 * - authMiddleware validates the API key and resolves tenantId
 * - adminOnly checks the key matches the ADMIN_API_KEY env var
 *
 * Also exposes:
 * - POST /admin/warm — pre-warm the cache before a demo or after a cold start
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash, timingSafeEqual } from 'crypto'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/admin-only.js'
import { can } from '../engine/can.js'
import { logger } from '../logger/index.js'
import { config } from '../config/index.js'
import { query } from '../db/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dashboardDir = join(__dirname, '..', 'dashboard')

function loadFile(filename: string, fallback: string): string {
    const path = join(dashboardDir, filename)
    try {
        if (existsSync(path)) return readFileSync(path, 'utf-8')
    } catch { /* ignore */ }
    return fallback
}

// Load dashboard files once at startup
const dashboardHtml = loadFile('index.html', '<html><body><h1>Dashboard not found</h1></body></html>')
const dashboardCss = loadFile('styles.css', '')
const dashboardJs = loadFile('app.js', '')

export async function adminRoute(fastify: FastifyInstance): Promise<void> {

    /**
     * GET /admin/verify — Dashboard login verification.
     *
     * Checks ONLY the ADMIN_API_KEY env var hash — no DB lookup, no tenant resolution.
     * This is the single entry point for the dashboard login screen.
     *
     * Returns 200 if the key matches, 401 if not set or wrong, 403 if dashboard disabled.
     */
    fastify.get('/admin/verify', async (request, reply) => {
        if (!config.admin.apiKeyHash) {
            return reply.status(403).send({ error: 'admin_dashboard_disabled' })
        }

        const rawKey = request.headers['x-api-key']
        if (!rawKey || typeof rawKey !== 'string') {
            return reply.status(401).send({ error: 'missing_api_key' })
        }

        const keyHash = createHash('sha256').update(rawKey).digest('hex')
        const a = Buffer.from(keyHash)
        const b = Buffer.from(config.admin.apiKeyHash ?? '')
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            logger.warn({ ip: request.ip }, 'admin_verify_denied')
            return reply.status(401).send({ error: 'invalid_admin_key' })
        }

        logger.info({ ip: request.ip }, 'admin_verify_success')
        return reply.status(200).send({ ok: true })
    })

    // Serve dashboard HTML — admin only
    fastify.get('/admin', {
        preHandler: [authMiddleware, adminOnly],
    }, async (_request, reply) => {
        return reply.type('text/html').send(dashboardHtml)
    })

    // Serve CSS — admin only
    fastify.get('/admin/styles.css', {
        preHandler: [authMiddleware, adminOnly],
    }, async (_request, reply) => {
        return reply.type('text/css').send(dashboardCss)
    })

    // Serve JS — admin only
    fastify.get('/admin/app.js', {
        preHandler: [authMiddleware, adminOnly],
    }, async (_request, reply) => {
        return reply.type('application/javascript').send(dashboardJs)
    })

    /**
     * POST /admin/warm — Pre-warm the cache before a demo or after a cold start.
     *
     * THE PROBLEM IT SOLVES:
     * After every server restart (Render redeploys, etc.), the cache is empty.
     * The first request for each user/resource pair hits full BFS (10–40ms).
     * In a demo, a slow first click destroys confidence.
     *
     * HOW TO USE (before a demo):
     * Send the list of (subject, action, object) pairs you're going to demo.
     * The server runs can() for each one, filling the cache.
     * Second request = <1ms cache hit. Demo looks instant.
     *
     * Example request:
     * POST /admin/warm
     * {
     *   "pairs": [
     *     { "subject": "user:arjun",  "action": "read",   "object": "shipment:TN001" },
     *     { "subject": "user:priya",  "action": "edit",   "object": "invoice:42" },
     *     { "subject": "user:ravi",   "action": "delete", "object": "report:Q4" }
     *   ]
     * }
     *
     * Example response:
     * {
     *   "warmed": 3,
     *   "results": [
     *     { "subject": "user:arjun", "action": "read", "object": "shipment:TN001", "status": "ALLOW", "latency_ms": 12.4 },
     *     { "subject": "user:priya", "action": "edit", "object": "invoice:42",     "status": "DENY",  "latency_ms": 8.1  },
     *     { "subject": "user:ravi",  "action": "delete","object": "report:Q4",     "status": "ALLOW", "latency_ms": 9.7  }
     *   ]
     * }
     *
     * Security: admin key only. Max 50 pairs per request to prevent abuse.
     */
    fastify.post<{
        Body: {
            pairs: Array<{ subject: string; action: string; object: string }>
        }
    }>('/admin/warm', {
        preHandler: [authMiddleware, adminOnly],
        schema: {
            body: {
                type: 'object',
                required: ['pairs'],
                properties: {
                    pairs: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 50,
                        items: {
                            type: 'object',
                            required: ['subject', 'action', 'object'],
                            properties: {
                                subject: { type: 'string', minLength: 1 },
                                action: { type: 'string', minLength: 1 },
                                object: { type: 'string', minLength: 1 },
                            },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const { pairs } = request.body

        logger.info({ tenantId, count: pairs.length }, 'cache_warm_started')

        // Run all can() calls in parallel — fills the cache for each pair
        const results = await Promise.all(
            pairs.map(async (p) => {
                const result = await can({
                    subject: p.subject,
                    action: p.action,
                    object: p.object,
                    tenantId,
                })
                return {
                    subject: p.subject,
                    action: p.action,
                    object: p.object,
                    status: result.status,
                    latency_ms: parseFloat(result.latency_ms.toFixed(2)),
                }
            })
        )

        logger.info({ tenantId, warmed: results.length }, 'cache_warm_complete')

        return reply.status(200).send({
            warmed: results.length,
            results,
        })
    })

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin-proxied data endpoints
    //
    // These endpoints accept ONLY the ADMIN_API_KEY (env var hash check, no DB).
    // They resolve the tenant via a tenantId query param (required).
    //
    // Dashboard uses these for all data operations so the UI needs exactly one key.
    // ─────────────────────────────────────────────────────────────────────────────

    /** Shared admin key guard — no DB, pure hash check. Rejects early if invalid. */
    async function guardAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
        if (!config.admin.apiKeyHash) {
            await reply.status(403).send({ error: 'admin_dashboard_disabled' })
            return false
        }
        const rawKey = request.headers['x-api-key']
        if (!rawKey || typeof rawKey !== 'string') {
            await reply.status(401).send({ error: 'missing_api_key' })
            return false
        }
        const keyHash = createHash('sha256').update(rawKey).digest('hex')
        const a = Buffer.from(keyHash)
        const b = Buffer.from(config.admin.apiKeyHash ?? '')
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            await reply.status(401).send({ error: 'invalid_admin_key' })
            return false
        }
        return true
    }

    // GET /admin/tenants — list all tenants (so dashboard can show a picker)
    fastify.get('/admin/tenants', async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        try {
            // No dedicated 'tenants' table — derive from api_keys which tracks tenant_id.
            const result = await query<{ id: string; name: string }>(
                `SELECT DISTINCT tenant_id AS id,
                        COALESCE(MAX(name), MAX(tenant_id::text)) AS name
                 FROM api_keys
                 GROUP BY tenant_id
                 ORDER BY name ASC`,
                []
            )
            return reply.status(200).send({ tenants: result.rows })
        } catch (err) {
            logger.error({ err }, 'admin_tenants_failed')
            return reply.status(500).send({ error: 'internal_error' })
        }
    })

    // GET /admin/logs?tenantId=xxx — fetch logs for a tenant
    fastify.get<{ Querystring: { tenantId?: string } }>('/admin/logs', async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        const tenantId = request.query.tenantId
        if (!tenantId) return reply.status(400).send({ error: 'tenantId query param required' })

        try {
            const result = await query<{
                id: string; subject: string; action: string; object: string;
                status: string; reason: string; latency_ms: number;
                cache_hit: boolean; trace: unknown; timestamp: string
            }>(
                `SELECT id, subject, action, object, status, reason, latency_ms, cache_hit, trace, created_at AS timestamp
                 FROM decision_logs
                 WHERE tenant_id = $1
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [tenantId]
            )
            return reply.status(200).send({ logs: result.rows })
        } catch {
            return reply.status(500).send({ error: 'internal_error' })
        }
    })

    // GET /admin/tuples?tenantId=xxx — list relationships for a tenant
    fastify.get<{ Querystring: { tenantId?: string; search?: string } }>('/admin/tuples', async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        const tenantId = request.query.tenantId
        if (!tenantId) return reply.status(400).send({ error: 'tenantId query param required' })

        const { search } = request.query
        let sql = 'SELECT subject, relation, object, created_at FROM tuples WHERE tenant_id = $1'
        const params: unknown[] = [tenantId]

        if (search) {
            params.push(`%${search}%`)
            sql += ` AND (subject ILIKE $2 OR object ILIKE $2)`
        }
        sql += ' ORDER BY created_at DESC LIMIT 200'

        try {
            const result = await query<{ subject: string; relation: string; object: string; created_at: string }>(sql, params)
            return reply.status(200).send({ tuples: result.rows })
        } catch {
            return reply.status(500).send({ error: 'internal_error' })
        }
    })

    // POST /admin/tuples — add a relationship (admin-proxied)
    fastify.post<{
        Body: { tenantId: string; subject: string; relation: string; object: string }
    }>('/admin/tuples', {
        schema: {
            body: {
                type: 'object',
                required: ['tenantId', 'subject', 'relation', 'object'],
                properties: {
                    tenantId: { type: 'string', minLength: 1 },
                    subject: { type: 'string', minLength: 1 },
                    relation: { type: 'string', minLength: 1 },
                    object: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        const { tenantId, subject, relation, object } = request.body
        const { getClient } = await import('../db/client.js')
        const { cache } = await import('../cache/lru.js')
        const { updateLocalLvn } = await import('../engine/lvn.js')
        const { indexGrant } = await import('../db/permission-index.js')
        const { getValidRelations, extractResourceType } = await import('../policy/config.js')

        const client = await getClient()
        try {
            await client.query('BEGIN')
            const lvnResult = await client.query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
            const nextvalA = lvnResult.rows[0]?.nextval
            if (!nextvalA) throw new Error('lvn_seq returned no rows — possible DB fault')
            const lvn = parseInt(nextvalA, 10)

            await client.query(
                `INSERT INTO tuples (tenant_id, subject, relation, object, lvn)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id, subject, relation, object) DO UPDATE SET lvn = EXCLUDED.lvn`,
                [tenantId, subject, relation, object, lvn]
            )
            await client.query('COMMIT')

            updateLocalLvn(lvn)
            cache.deleteByChanged(tenantId, subject, object)

            const resourceType = extractResourceType(object)
            const allActions = ['read', 'edit', 'delete', 'manage', 'write', 'approve']
            const grantedActions = allActions.filter(a => getValidRelations(a, resourceType).includes(relation))
            indexGrant(tenantId, subject, relation, object, grantedActions)
                .catch((err: unknown) => logger.warn({ err }, 'admin_perm_index_grant_failed'))

            logger.info({ tenantId, subject, relation, object, lvn }, 'admin_tuple_added')
            return reply.status(200).send({ success: true, lvn })
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { })
            logger.error({ err }, 'admin_tuple_add_failed')
            return reply.status(500).send({ error: 'internal_error' })
        } finally {
            client.release()
        }
    })

    // DELETE /admin/tuples — remove a relationship (admin-proxied)
    fastify.delete<{
        Body: { tenantId: string; subject: string; relation: string; object: string }
    }>('/admin/tuples', {
        schema: {
            body: {
                type: 'object',
                required: ['tenantId', 'subject', 'relation', 'object'],
                properties: {
                    tenantId: { type: 'string', minLength: 1 },
                    subject: { type: 'string', minLength: 1 },
                    relation: { type: 'string', minLength: 1 },
                    object: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        const { tenantId, subject, relation, object } = request.body
        const { getClient } = await import('../db/client.js')
        const { cache } = await import('../cache/lru.js')
        const { updateLocalLvn } = await import('../engine/lvn.js')
        const { removeGrant } = await import('../db/permission-index.js')

        const client = await getClient()
        try {
            await client.query('BEGIN')
            await client.query(
                `DELETE FROM tuples WHERE tenant_id=$1 AND subject=$2 AND relation=$3 AND object=$4`,
                [tenantId, subject, relation, object]
            )
            const lvnResult = await client.query<{ nextval: string }>(`SELECT nextval('lvn_seq') as nextval`)
            const nextvalA = lvnResult.rows[0]?.nextval
            if (!nextvalA) throw new Error('lvn_seq returned no rows — possible DB fault')
            const lvn = parseInt(nextvalA, 10)
            await client.query('COMMIT')

            updateLocalLvn(lvn)
            cache.deleteByChanged(tenantId, subject, object)
            removeGrant(tenantId, subject, relation, object)
                .catch((err: unknown) => logger.warn({ err }, 'admin_perm_index_remove_failed'))

            logger.info({ tenantId, subject, relation, object }, 'admin_tuple_removed')
            return reply.status(200).send({ success: true })
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { })
            logger.error({ err }, 'admin_tuple_delete_failed')
            return reply.status(500).send({ error: 'internal_error' })
        } finally {
            client.release()
        }
    })

    // POST /admin/can — check access (admin-proxied, does not require tenant key)
    fastify.post<{
        Body: { tenantId: string; subject: string; action: string; object: string }
    }>('/admin/can', {
        schema: {
            body: {
                type: 'object',
                required: ['tenantId', 'subject', 'action', 'object'],
                properties: {
                    tenantId: { type: 'string', minLength: 1 },
                    subject: { type: 'string', minLength: 1 },
                    action: { type: 'string', minLength: 1 },
                    object: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request, reply) => {
        if (!await guardAdmin(request, reply)) return

        const { tenantId, subject, action, object } = request.body
        const result = await can({ subject, action, object, tenantId })
        return reply.status(200).send(result)
    })
}

