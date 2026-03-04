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
    /** Retry config. Set to false to disable. Default: enabled with 3 attempts */
    retry?: false | {
        /** Max retry attempts (not counting the initial request). Default: 2 */
        attempts?: number
        /** Initial backoff delay in ms. Doubles on each retry. Default: 200 */
        baseDelay?: number
        /** Max backoff delay in ms. Default: 2000 */
        maxDelay?: number
    }
    /** Circuit breaker config. Set to false to disable. Default: enabled */
    circuitBreaker?: false | {
        /** Number of consecutive failures to trip the circuit. Default: 5 */
        threshold?: number
        /** Time in ms to wait before trying again after circuit opens. Default: 30000 (30s) */
        resetTimeout?: number
    }
    /** Local decision cache config. Set to false to disable. Default: disabled */
    cache?: false | {
        /** Max number of cached decisions. Default: 1000 */
        maxSize?: number
        /** Time-to-live in ms for cached decisions. Default: 30000 (30s) */
        ttl?: number
    }
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
