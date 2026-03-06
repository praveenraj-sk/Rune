/**
 * In-memory database adapter for running tests WITHOUT Postgres.
 *
 * Enables zero-dependency test runs: `RUNE_TEST_MODE=memory pnpm test`
 *
 * HOW IT WORKS:
 *   Instead of parsing arbitrary SQL, this adapter pattern-matches the ~20 known
 *   SQL queries the engine uses and routes them to simple in-memory data structures.
 *   This is safe because the engine's SQL is fully parameterized and stable.
 *
 * SUPPORTED:
 *   - Tuple CRUD (the full BFS/can pipeline)
 *   - Permission index (O(1) lookups, batch inserts, deletes)
 *   - Decision logs (INSERT + SELECT)
 *   - LVN sequence (nextval, last_value)
 *   - Health probe (SELECT 1)
 *   - Stats/counts
 *
 * NOT SUPPORTED (use real Postgres for integration tests):
 *   - ILIKE search filters
 *   - RANDOM() sampling
 *   - Complex GROUP BY aggregations
 *   - Transaction isolation (BEGIN/COMMIT are no-ops)
 *
 * @example
 *   import { enableMemoryMode, resetMemoryStore } from '../db/memory-adapter.js'
 *   enableMemoryMode()
 *   beforeEach(() => resetMemoryStore())
 */
import type pg from 'pg'

// ── Data Structures ─────────────────────────────────────────────────────────

type Tuple = {
    tenant_id: string
    subject: string
    relation: string
    object: string
    lvn: number
    created_at: Date
}

type PermissionEntry = {
    tenant_id: string
    subject: string
    action: string
    object: string
    granted_by: string
}

type DecisionLog = {
    id: string
    tenant_id: string
    subject: string
    action: string
    object: string
    decision: string
    status: string
    reason: string
    trace: string
    suggested_fix: string | null
    lvn: number
    latency_ms: number
    cache_hit: boolean
    created_at: Date
}

type ApiKey = {
    id: string
    tenant_id: string
    key_hash: string
    name: string
}

// ── Store ───────────────────────────────────────────────────────────────────

const store = {
    tuples: [] as Tuple[],
    permissionIndex: [] as PermissionEntry[],
    decisionLogs: [] as DecisionLog[],
    apiKeys: [] as ApiKey[],
    lvnSeq: 1,
}

/** Reset all in-memory data. Call in beforeEach() for test isolation. */
export function resetMemoryStore(): void {
    store.tuples = []
    store.permissionIndex = []
    store.decisionLogs = []
    store.apiKeys = []
    store.lvnSeq = 1
}

/** Direct access for test assertions (e.g., check log count). */
export function getMemoryStore() {
    return store
}

// ── Result Builder ──────────────────────────────────────────────────────────

function makeResult<T>(rows: T[]): pg.QueryResult<T & pg.QueryResultRow> {
    return {
        rows: rows as (T & pg.QueryResultRow)[],
        rowCount: rows.length,
        command: '',
        oid: 0,
        fields: [],
    }
}

// ── UUID Generator ──────────────────────────────────────────────────────────

let idCounter = 0
function uuid(): string {
    idCounter++
    return `mem-${idCounter.toString().padStart(8, '0')}`
}

// ── SQL Pattern Matcher ─────────────────────────────────────────────────────
// Each handler receives (sql, params) and returns a QueryResult or null.
// First match wins. Order matters for overlapping patterns.

type Handler = (sql: string, params: unknown[]) => pg.QueryResult<pg.QueryResultRow> | null

const handlers: Handler[] = [
    // ── Health ────────────────────────────────────────────────────────
    (sql) => {
        if (sql.trim() === 'SELECT 1') return makeResult([{ '?column?': 1 }])
        return null
    },

    // ── Transaction control (no-ops in memory) ───────────────────────
    (sql) => {
        const s = sql.trim().toUpperCase()
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return makeResult([])
        return null
    },

    // ── LVN sequence ─────────────────────────────────────────────────
    (sql) => {
        if (sql.includes('nextval')) {
            store.lvnSeq++
            return makeResult([{ nextval: store.lvnSeq }])
        }
        if (sql.includes('last_value') && sql.includes('lvn_seq')) {
            return makeResult([{ last_value: store.lvnSeq }])
        }
        return null
    },

    // ── Tuple: existence check (BFS uses this) ──────────────────────
    (sql, params) => {
        if (sql.includes('SELECT 1 FROM tuples') && sql.includes('LIMIT 1')) {
            const tenantId = params[0] as string
            const object = params[1] as string
            const found = store.tuples.some(
                (t) => t.tenant_id === tenantId && t.object === object,
            )
            return makeResult(found ? [{ '?column?': 1 }] : [])
        }
        return null
    },

    // ── Tuple: BFS frontier expansion (ANY array) ───────────────────
    (sql, params) => {
        if (sql.includes('FROM tuples') && sql.includes('ANY')) {
            const tenantId = params[0] as string
            const subjects = params[1] as string[]
            const subjectSet = new Set(subjects)
            const rows = store.tuples
                .filter((t) => t.tenant_id === tenantId && subjectSet.has(t.subject))
                .map((t) => ({ subject: t.subject, relation: t.relation, object: t.object }))
            return makeResult(rows)
        }
        return null
    },

    // ── Tuple: INSERT (upsert with ON CONFLICT) ─────────────────────
    (sql, params) => {
        if (sql.includes('INSERT INTO tuples')) {
            const tenantId = params[0] as string
            const subject = params[1] as string
            const relation = params[2] as string
            const object = params[3] as string
            const lvn = (params[4] as number) ?? store.lvnSeq

            // Remove existing (upsert behavior)
            store.tuples = store.tuples.filter(
                (t) =>
                    !(
                        t.tenant_id === tenantId &&
                        t.subject === subject &&
                        t.relation === relation &&
                        t.object === object
                    ),
            )
            store.tuples.push({
                tenant_id: tenantId,
                subject,
                relation,
                object,
                lvn,
                created_at: new Date(),
            })
            return makeResult([])
        }
        return null
    },

    // ── Tuple: DELETE ────────────────────────────────────────────────
    (sql, params) => {
        if (sql.includes('DELETE FROM tuples') && params.length >= 4) {
            const tenantId = params[0] as string
            const subject = params[1] as string
            const relation = params[2] as string
            const object = params[3] as string
            const before = store.tuples.length
            store.tuples = store.tuples.filter(
                (t) =>
                    !(
                        t.tenant_id === tenantId &&
                        t.subject === subject &&
                        t.relation === relation &&
                        t.object === object
                    ),
            )
            const deleted = before - store.tuples.length
            return { ...makeResult([]), rowCount: deleted }
        }
        // DELETE all tuples for tenant (cleanup)
        if (sql.includes('DELETE FROM tuples') && params.length === 1) {
            const tenantId = params[0] as string
            store.tuples = store.tuples.filter((t) => t.tenant_id !== tenantId)
            return makeResult([])
        }
        return null
    },

    // ── Tuple: SELECT with tenant_id (list / graph) ─────────────────
    (sql, params) => {
        if (sql.includes('SELECT') && sql.includes('FROM tuples') && sql.includes('tenant_id')) {
            const tenantId = params[0] as string

            // COUNT query
            if (sql.includes('COUNT(*)')) {
                const count = store.tuples.filter((t) => t.tenant_id === tenantId).length
                return makeResult([{ count }])
            }

            // Graph: subject OR object match
            if (sql.includes('OR object')) {
                const searchNode = params[1] as string
                const limit = (params[2] as number) ?? 500
                const rows = store.tuples
                    .filter(
                        (t) =>
                            t.tenant_id === tenantId &&
                            (t.subject === searchNode || t.object === searchNode),
                    )
                    .slice(0, limit)
                    .map((t) => ({
                        subject: t.subject,
                        relation: t.relation,
                        object: t.object,
                    }))
                return makeResult(rows)
            }

            // Graph: subject IN or object IN (neighbor expansion)
            if (sql.includes(' IN (')) {
                const limit = (params[1] as number) ?? 500
                const neighbors = params.slice(2) as string[]
                const neighborSet = new Set(neighbors)
                const rows = store.tuples
                    .filter(
                        (t) =>
                            t.tenant_id === tenantId &&
                            (neighborSet.has(t.subject) || neighborSet.has(t.object)),
                    )
                    .slice(0, limit)
                    .map((t) => ({
                        subject: t.subject,
                        relation: t.relation,
                        object: t.object,
                    }))
                return makeResult(rows)
            }

            // Default: list tuples for tenant (with limit)
            const limitMatch = sql.match(/LIMIT\s+\$(\d+)/)
            const limit = limitMatch?.[1] ? (params[parseInt(limitMatch[1]) - 1] as number) : 200
            const rows = store.tuples
                .filter((t) => t.tenant_id === tenantId)
                .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
                .slice(0, limit)
                .map((t) => ({
                    subject: t.subject,
                    relation: t.relation,
                    object: t.object,
                    created_at: t.created_at,
                }))
            return makeResult(rows)
        }
        return null
    },

    // ── Permission Index: EXISTS check ──────────────────────────────
    (sql, params) => {
        if (sql.includes('permission_index') && sql.includes('EXISTS')) {
            const tenantId = params[0] as string
            const subject = params[1] as string
            const action = params[2] as string
            const object = params[3] as string
            const exists = store.permissionIndex.some(
                (p) =>
                    p.tenant_id === tenantId &&
                    p.subject === subject &&
                    p.action === action &&
                    p.object === object,
            )
            return makeResult([{ exists }])
        }
        return null
    },

    // ── Permission Index: batch INSERT ──────────────────────────────
    (sql, params) => {
        if (sql.includes('INSERT INTO permission_index')) {
            // Params are flat: [tenantId, subject, action1, object, grantedBy, tenantId, subject, action2, ...]
            // Each entry has 5 fields
            for (let i = 0; i + 4 < params.length; i += 5) {
                const entry: PermissionEntry = {
                    tenant_id: params[i] as string,
                    subject: params[i + 1] as string,
                    action: params[i + 2] as string,
                    object: params[i + 3] as string,
                    granted_by: params[i + 4] as string,
                }
                // ON CONFLICT DO NOTHING
                const exists = store.permissionIndex.some(
                    (p) =>
                        p.tenant_id === entry.tenant_id &&
                        p.subject === entry.subject &&
                        p.action === entry.action &&
                        p.object === entry.object,
                )
                if (!exists) store.permissionIndex.push(entry)
            }
            return makeResult([])
        }
        return null
    },

    // ── Permission Index: DELETE by granted_by ──────────────────────
    (sql, params) => {
        if (sql.includes('DELETE FROM permission_index') && sql.includes('granted_by')) {
            const tenantId = params[0] as string
            const grantedBy = params[1] as string
            store.permissionIndex = store.permissionIndex.filter(
                (p) => !(p.tenant_id === tenantId && p.granted_by === grantedBy),
            )
            return makeResult([])
        }
        // DELETE all for tenant
        if (sql.includes('DELETE FROM permission_index') && params.length === 1) {
            const tenantId = params[0] as string
            store.permissionIndex = store.permissionIndex.filter(
                (p) => p.tenant_id !== tenantId,
            )
            return makeResult([])
        }
        return null
    },

    // ── Decision Logs: INSERT ───────────────────────────────────────
    (sql, params) => {
        if (sql.includes('INSERT INTO decision_logs')) {
            const log: DecisionLog = {
                id: uuid(),
                tenant_id: params[0] as string,
                subject: params[1] as string,
                action: params[2] as string,
                object: params[3] as string,
                decision: params[4] as string,
                status: params[5] as string,
                reason: params[6] as string,
                trace: params[7] as string,
                suggested_fix: params[8] as string | null,
                lvn: params[9] as number,
                latency_ms: params[10] as number,
                cache_hit: params[11] as boolean,
                created_at: new Date(),
            }
            store.decisionLogs.push(log)
            return makeResult([])
        }
        return null
    },

    // ── Decision Logs: SELECT (recent logs) ─────────────────────────
    (sql, params) => {
        if (sql.includes('FROM decision_logs') && sql.includes('SELECT') && sql.includes('tenant_id')) {
            const tenantId = params[0] as string

            // COUNT with allow/deny breakdown
            if (sql.includes('COUNT(*)') && sql.includes('FILTER')) {
                const todayLogs = store.decisionLogs.filter(
                    (l) =>
                        l.tenant_id === tenantId &&
                        l.created_at.toDateString() === new Date().toDateString(),
                )
                return makeResult([{
                    count: todayLogs.length,
                    allow_count: todayLogs.filter((l) => l.decision === 'allow').length,
                    deny_count: todayLogs.filter((l) => l.decision === 'deny').length,
                }])
            }

            // Latency-only query (stats)
            if (sql.includes('latency_ms') && !sql.includes('subject')) {
                const rows = store.decisionLogs
                    .filter((l) => l.tenant_id === tenantId)
                    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
                    .slice(0, 100)
                    .map((l) => ({ latency_ms: l.latency_ms }))
                return makeResult(rows)
            }

            // Full log fetch
            const rows = store.decisionLogs
                .filter((l) => l.tenant_id === tenantId)
                .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
                .slice(0, 100)
                .map((l) => ({
                    id: l.id,
                    subject: l.subject,
                    action: l.action,
                    object: l.object,
                    decision: l.decision,
                    status: l.status,
                    reason: l.reason,
                    trace: l.trace,
                    suggested_fix: l.suggested_fix,
                    latency_ms: l.latency_ms,
                    cache_hit: l.cache_hit,
                    created_at: l.created_at,
                    timestamp: l.created_at,
                }))
            return makeResult(rows)
        }
        return null
    },

    // ── Decision Logs: DELETE (cleanup) ──────────────────────────────
    (sql, params) => {
        if (sql.includes('DELETE FROM decision_logs') && params.length === 1) {
            const tenantId = params[0] as string
            store.decisionLogs = store.decisionLogs.filter(
                (l) => l.tenant_id !== tenantId,
            )
            return makeResult([])
        }
        return null
    },

    // ── API Keys: INSERT ────────────────────────────────────────────
    (sql, params) => {
        if (sql.includes('INSERT INTO api_keys')) {
            store.apiKeys.push({
                id: uuid(),
                tenant_id: params[0] as string,
                key_hash: params[1] as string,
                name: params[2] as string,
            })
            return makeResult([])
        }
        return null
    },

    // ── API Keys: SELECT (admin tenant list) ────────────────────────
    (sql) => {
        if (sql.includes('FROM api_keys') && sql.includes('GROUP BY')) {
            const tenantMap = new Map<string, string>()
            for (const k of store.apiKeys) {
                if (!tenantMap.has(k.tenant_id)) {
                    tenantMap.set(k.tenant_id, k.name ?? k.tenant_id)
                }
            }
            const rows = [...tenantMap.entries()].map(([id, name]) => ({ id, name }))
            return makeResult(rows)
        }
        return null
    },

    // ── Explain: reverse lookup for suggested fix ───────────────────
    (sql, params) => {
        if (sql.includes('FROM tuples') && sql.includes('relation = ANY') && sql.includes('LIMIT')) {
            const tenantId = params[0] as string
            const object = params[1] as string
            const relations = params[2] as string[]
            const relationSet = new Set(relations)
            const rows = store.tuples
                .filter(
                    (t) =>
                        t.tenant_id === tenantId &&
                        t.object === object &&
                        relationSet.has(t.relation),
                )
                .slice(0, 5)
                .map((t) => ({ subject: t.subject, relation: t.relation }))
            return makeResult(rows)
        }
        return null
    },

    // ── ALTER TABLE (setup migrations — no-ops in memory) ───────────
    (sql) => {
        if (sql.includes('ALTER TABLE')) return makeResult([])
        return null
    },
]

// ── Public Query Function ───────────────────────────────────────────────────

/**
 * Execute a SQL query against the in-memory store.
 * Pattern-matches known engine queries — throws on unrecognized SQL.
 */
export function memoryQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
): pg.QueryResult<T> {
    for (const handler of handlers) {
        const result = handler(sql, params)
        if (result) return result as pg.QueryResult<T>
    }

    // Unrecognized query — fail loudly so we know what to add
    throw new Error(
        `[memory-adapter] Unrecognized SQL pattern:\n  ${sql.slice(0, 200)}\n  params: ${JSON.stringify(params).slice(0, 200)}`,
    )
}

// ── Mode Switching ──────────────────────────────────────────────────────────

let memoryMode = false

export function isMemoryMode(): boolean {
    return memoryMode
}

export function enableMemoryMode(): void {
    memoryMode = true
    resetMemoryStore()
}

export function disableMemoryMode(): void {
    memoryMode = false
}
