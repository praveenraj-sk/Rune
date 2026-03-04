/**
 * Rune SDK — Types
 * All types shared between the client, fluent builder, and responses.
 *
 * Naming convention: "What IS it?" — plain English nouns, no jargon.
 */

/** Options passed when creating a new Rune client */
export type RuneOptions = {
    apiKey: string
    baseUrl: string
    /** Request timeout in ms. Default: 5000 */
    timeout?: number
}

/** Result of a permission check — what you get back from rune.check() */
export type Permission = {
    decision: 'allow' | 'deny'
    status: 'ALLOW' | 'DENY' | 'NOT_FOUND' | 'CHALLENGE'
    reason: string
    trace: Array<{ node: string; result: 'start' | 'connected' | 'not_connected' }>
    suggested_fix: string[]
    cache_hit: boolean
    latency_ms: number
    sct: { lvn: number }
}

/** A relationship between a subject, relation, and object */
export type Grant = {
    subject: string
    relation: string
    object: string
}

/** Result of adding or removing a relationship */
export type GrantResult = {
    success: boolean
    lvn: number
}

/** A single entry in the decision audit log */
export type Audit = {
    id: string
    subject: string
    action: string
    object: string
    decision: 'allow' | 'deny'
    status: string
    reason: string | null
    latency_ms: number
    cache_hit: boolean
    created_at: string
}

/** The full audit log — list of recent decisions */
export type AuditLog = {
    logs: Audit[]
}

/** Current health status of the engine */
export type HealthStatus = {
    status: 'ok' | 'degraded'
    db: 'connected' | 'error'
    timestamp: string
}

/** Any action string — built-in: 'read' | 'edit' | 'delete' | 'manage', plus any custom action */
export type Action = string
