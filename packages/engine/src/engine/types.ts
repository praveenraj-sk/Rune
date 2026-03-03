/**
 * Engine types shared between can.ts, explain.ts, and routes.
 */

export type TraceNode = {
    node: string
    result: 'start' | 'connected' | 'not_connected'
}

export type CanInput = {
    subject: string
    action: string
    object: string
    tenantId: string
    context?: { time?: string }
    sct?: { lvn: number }
}

export type CanResult = {
    decision: 'allow' | 'deny'
    status: 'ALLOW' | 'DENY' | 'CHALLENGE' | 'NOT_FOUND'
    reason: string
    trace: TraceNode[]
    suggested_fix: string[]
    cache_hit: boolean
    latency_ms: number
    sct: { lvn: number }
}

/**
 * Factory for a safe DENY result.
 * All error paths return this to guarantee fail-closed behaviour.
 */
export function makeDenyResult(reason: string, lvn = 0): CanResult {
    return {
        decision: 'deny',
        status: 'DENY',
        reason,
        trace: [],
        suggested_fix: [],
        cache_hit: false,
        latency_ms: 0,
        sct: { lvn },
    }
}
