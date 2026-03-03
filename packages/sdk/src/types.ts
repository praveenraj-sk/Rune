/**
 * Rune SDK — Types
 * All types shared between the client, fluent builder, and responses.
 */

export type RuneConfig = {
    apiKey: string
    baseUrl: string
    /** Request timeout in ms. Default: 5000 */
    timeout?: number
}

export type CanResult = {
    decision: 'allow' | 'deny'
    status: 'ALLOW' | 'DENY' | 'NOT_FOUND' | 'CHALLENGE'
    reason: string
    trace: Array<{ node: string; result: 'start' | 'connected' | 'not_connected' }>
    suggested_fix: string[]
    cache_hit: boolean
    latency_ms: number
    sct: { lvn: number }
}

export type TupleInput = {
    subject: string
    relation: 'owner' | 'editor' | 'viewer' | 'member'
    object: string
}

export type TupleResult = {
    success: boolean
    lvn: number
}

export type Log = {
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

export type LogsResult = {
    logs: Log[]
}

export type HealthResult = {
    status: 'ok' | 'degraded'
    db: 'connected' | 'error'
    timestamp: string
}

/** The 4 supported actions */
export type Action = 'read' | 'edit' | 'delete' | 'manage'
