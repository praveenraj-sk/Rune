/**
 * Core authorization decision function.
 *
 * PIPELINE (in exact order):
 * 1. Validate inputs → DENY on any empty field
 * 2. Build cache key
 * 3. Check SCT freshness (bypass cache if stale)
 * 4. Check LRU cache → return if cache hit
 * 5. Check permission index (O(1) Postgres lookup) → return if index hit
 * 6. BFS traversal
 * 7. Handle NOT_FOUND (don't cache)
 * 8. Handle limit hits (don't cache)
 * 9. Build explainability (trace, reason, suggested_fix)
 * 10. Get current LVN
 * 11. Cache result (ALLOW and DENY only)
 * 12. Log decision (fire and forget — never await)
 * 13. Return CanResult
 *
 * FAIL CLOSED: the entire function is wrapped in try/catch.
 * Any unhandled error returns DENY. Code that should be ALLOW
 * must explicitly reach the ALLOW code path.
 */
import { cache } from '../cache/lru.js'
import { query } from '../db/client.js'
import { traverse } from '../bfs/traverse.js'
import { checkIndex } from '../db/permission-index.js'
import { buildTrace, buildReason, buildSuggestedFix } from './explain.js'
import { logger } from '../logger/index.js'
import { makeDenyResult, type CanInput, type CanResult } from './types.js'

export async function can(input: CanInput): Promise<CanResult> {
    const start = performance.now()

    try {
        // Step 1: Validate inputs (fail closed on missing fields)
        if (!input.subject) return { ...makeDenyResult('invalid_subject'), latency_ms: performance.now() - start }
        if (!input.action) return { ...makeDenyResult('invalid_action'), latency_ms: performance.now() - start }
        if (!input.object) return { ...makeDenyResult('invalid_object'), latency_ms: performance.now() - start }
        if (!input.tenantId) return { ...makeDenyResult('invalid_tenant_id'), latency_ms: performance.now() - start }

        // Step 2: Build cache key
        const cacheKey = cache.buildKey(input.tenantId, input.subject, input.object, input.action)

        // Step 3 + 4: SCT freshness check and cache lookup
        const reqLvn = input.sct?.lvn ?? 0
        const isStaleSct = reqLvn > 0 && cache.isStale(cacheKey, reqLvn)

        if (!isStaleSct) {
            const cached = cache.get(cacheKey)
            if (cached) {
                const lvn = await getCurrentLvn()
                const result: CanResult = {
                    decision: cached.decision,
                    status: cached.decision === 'allow' ? 'ALLOW' : 'DENY',
                    reason: 'served from cache',
                    trace: [],
                    suggested_fix: [],
                    cache_hit: true,
                    index_hit: false,
                    latency_ms: performance.now() - start,
                    sct: { lvn },
                }
                logDecision(input, result)
                return result
            }
        }

        // Step 5: Permission index — O(1) Postgres lookup before BFS
        const indexHit = await checkIndex(input.tenantId, input.subject, input.action, input.object)
        if (indexHit) {
            const lvn = await getCurrentLvn()
            const result: CanResult = {
                decision: 'allow',
                status: 'ALLOW',
                reason: 'allowed via permission index',
                trace: [],
                suggested_fix: [],
                cache_hit: false,
                index_hit: true,
                latency_ms: performance.now() - start,
                sct: { lvn },
            }
            // Cache this hit so subsequent checks are LRU-served
            cache.set(cacheKey, { decision: 'allow', lvn })
            logDecision(input, result)
            return result
        }

        // Step 6: BFS traversal
        const traversal = await traverse(input.tenantId, input.subject, input.object, input.action)

        // Step 6: NOT_FOUND — object doesn't exist in tuple store
        if (!traversal.objectExists) {
            const lvn = await getCurrentLvn()
            return {
                decision: 'deny',
                status: 'NOT_FOUND',
                reason: buildReason({ ...traversal, subject: input.subject, object: input.object, action: input.action }),
                trace: [],
                suggested_fix: [],
                cache_hit: false,
                index_hit: false,
                latency_ms: performance.now() - start,
                sct: { lvn },
            }
        }

        // Step 8: Limit hit — don't cache, return DENY
        if (traversal.limitHit !== null) {
            const lvn = await getCurrentLvn()
            return {
                decision: 'deny',
                status: 'DENY',
                reason: buildReason({ ...traversal, subject: input.subject, object: input.object, action: input.action }),
                trace: buildTrace(traversal.path, false),
                suggested_fix: [],
                cache_hit: false,
                index_hit: false,
                latency_ms: performance.now() - start,
                sct: { lvn },
            }
        }

        // Step 8: Build explainability
        const decision = traversal.found ? 'allow' : 'deny'
        const status = traversal.found ? 'ALLOW' : 'DENY'
        const trace = buildTrace(traversal.path, traversal.found)
        const reason = buildReason({ ...traversal, subject: input.subject, object: input.object, action: input.action })
        const suggestedFix = traversal.found
            ? []
            : await buildSuggestedFix(input.tenantId, input.subject, input.object, input.action)

        // Step 9: Get current LVN
        const lvn = await getCurrentLvn()

        // Step 10: Cache (ALLOW and DENY, not NOT_FOUND or limit hits)
        cache.set(cacheKey, { decision, lvn })

        // Step 11 + 12: Build result, log (fire and forget), return
        const result: CanResult = {
            decision,
            status,
            reason,
            trace,
            suggested_fix: suggestedFix,
            cache_hit: false,
            index_hit: false,
            latency_ms: performance.now() - start,
            sct: { lvn },
        }

        // Slow authorization warning — flag requests exceeding threshold for debugging
        const SLOW_THRESHOLD_MS = 20
        if (result.latency_ms > SLOW_THRESHOLD_MS) {
            logger.warn({
                subject: input.subject,
                action: input.action,
                object: input.object,
                tenantId: input.tenantId,
                latency_ms: result.latency_ms.toFixed(2),
                bfs_depth: traversal.depthReached,
                bfs_nodes: traversal.nodeCount,
            }, 'slow_authorization_decision')
        }

        logDecision(input, result)
        return result

    } catch (error) {
        // FAIL CLOSED: any unexpected error returns DENY — never allows
        logger.error({ error: (error as Error).message, subject: input.subject, object: input.object }, 'can_function_error')
        return { ...makeDenyResult('service_error'), latency_ms: performance.now() - start }
    }
}

async function getCurrentLvn(): Promise<number> {
    try {
        const result = await query<{ last_value: string }>('SELECT last_value FROM lvn_seq')
        return parseInt(result.rows[0]?.last_value ?? '0', 10)
    } catch {
        return 0  // LVN failure must not fail the decision
    }
}

function logDecision(input: CanInput, result: CanResult): void {
    // Fire and forget — decision log failure must never affect the response
    query(
        `INSERT INTO decision_logs
     (tenant_id, subject, action, object, decision, status, reason, trace, suggested_fix, lvn, latency_ms, cache_hit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
            input.tenantId,
            input.subject,
            input.action,
            input.object,
            result.decision,
            result.status,
            result.reason,
            JSON.stringify(result.trace),
            JSON.stringify(result.suggested_fix),
            result.sct.lvn,
            result.latency_ms,
            result.cache_hit,
        ]
    ).catch((err: unknown) => logger.error({ err }, 'decision_log_insert_failed'))
}
