/**
 * POST /v1/can/batch — Check multiple permissions in a single round-trip.
 *
 * WHY: A page showing 10 resources needs 10 separate can() calls.
 * Without batch: 10 HTTP round-trips × 5ms = 50ms total.
 * With batch: 1 HTTP round-trip, 10 parallel can() calls = ~8ms total.
 *
 * Max 25 checks per request to prevent abuse.
 *
 * Example request:
 * POST /v1/can/batch
 * {
 *   "checks": [
 *     { "subject": "user:arjun", "action": "read",   "object": "shipment:TN001" },
 *     { "subject": "user:arjun", "action": "delete", "object": "shipment:TN001" },
 *     { "subject": "user:arjun", "action": "read",   "object": "invoice:42" }
 *   ]
 * }
 *
 * Example response:
 * {
 *   "results": [
 *     { "subject": "user:arjun", "action": "read",   "object": "shipment:TN001", "decision": "allow", "status": "ALLOW", "latency_ms": 0.4 },
 *     { "subject": "user:arjun", "action": "delete", "object": "shipment:TN001", "decision": "deny",  "status": "DENY",  "latency_ms": 3.2 },
 *     { "subject": "user:arjun", "action": "read",   "object": "invoice:42",     "decision": "allow", "status": "ALLOW", "latency_ms": 0.3 }
 *   ],
 *   "total_latency_ms": 3.8
 * }
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { can } from '../engine/can.js'

export async function batchRoute(fastify: FastifyInstance): Promise<void> {
    fastify.post<{
        Body: {
            checks: Array<{
                subject: string
                action: string
                object: string
                sct?: { lvn: number }
            }>
        }
    }>('/can/batch', {
        preHandler: [authMiddleware, rateLimitMiddleware],
        schema: {
            body: {
                type: 'object',
                required: ['checks'],
                properties: {
                    checks: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 25,
                        items: {
                            type: 'object',
                            required: ['subject', 'action', 'object'],
                            properties: {
                                subject: { type: 'string', minLength: 1 },
                                action:  { type: 'string', minLength: 1 },
                                object:  { type: 'string', minLength: 1 },
                                sct: {
                                    type: 'object',
                                    properties: { lvn: { type: 'number' } },
                                },
                            },
                        },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const tenantId = request.tenantId
        const start = performance.now()

        // Run all checks in parallel — each can() is independent
        const results = await Promise.all(
            request.body.checks.map(async (check) => {
                const result = await can({
                    subject: check.subject,
                    action: check.action,
                    object: check.object,
                    tenantId,
                    ...(check.sct ? { sct: check.sct } : {}),
                })
                return {
                    subject: check.subject,
                    action: check.action,
                    object: check.object,
                    decision: result.decision,
                    status: result.status,
                    cache_hit: result.cache_hit,
                    latency_ms: parseFloat(result.latency_ms.toFixed(2)),
                }
            })
        )

        return reply.status(200).send({
            results,
            total_latency_ms: parseFloat((performance.now() - start).toFixed(2)),
        })
    })
}
