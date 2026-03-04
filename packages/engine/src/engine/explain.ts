/**
 * Explainability engine.
 *
 * Converts raw BFS traversal data into human-readable output:
 * - trace:         "which nodes were visited and did they connect?"
 * - reason:        "why was this decision made?"
 * - suggested_fix: "how can the denied user get access?"
 *
 * All functions are pure or fail safely — they must never cause the
 * main can() function to throw or return ALLOW when it should DENY.
 */
import { query } from '../db/client.js'
import { getValidRelations } from '../bfs/types.js'
import { logger } from '../logger/index.js'
import type { TraceNode } from './types.js'

/**
 * Builds a trace array from the BFS path.
 * Each node is marked: 'start', 'connected', or 'not_connected'.
 */
export function buildTrace(path: string[], found: boolean): TraceNode[] {
    if (path.length === 0) return []
    return path.map((node, index) => {
        if (index === 0) return { node, result: 'start' as const }
        // In a failed traversal, the last node we visited couldn't connect
        if (!found && index === path.length - 1) {
            return { node, result: 'not_connected' as const }
        }
        return { node, result: 'connected' as const }
    })
}

/**
 * Returns a single plain-English reason sentence.
 */
export function buildReason(params: {
    found: boolean
    objectExists: boolean
    limitHit: 'depth' | 'nodes' | null
    subject: string
    object: string
    action: string
}): string {
    const { found, objectExists, limitHit, subject, object, action } = params
    if (!objectExists) return `Resource ${object} does not exist`
    if (limitHit === 'depth') return `Relationship graph exceeded depth limit — possible misconfiguration`
    if (limitHit === 'nodes') return `Relationship graph exceeded node limit — possible misconfiguration`
    if (found) return `Access granted — valid relationship found between ${subject} and ${object}`
    return `No valid relationship found between ${subject} and ${object} for action: ${action}`
}

/**
 * Queries which groups already have access to `object` and returns
 * plain-English suggestions for how to grant access to `subject`.
 *
 * Returns a safe fallback on any error — must never throw.
 */
export async function buildSuggestedFix(
    tenantId: string,
    subject: string,
    object: string,
    action: string,
): Promise<string[]> {
    try {
        const validRelations = getValidRelations(action)

        const result = await query<{ subject: string; relation: string }>(
            `SELECT subject, relation
       FROM   tuples
       WHERE  tenant_id = $1
         AND  object    = $2
         AND  relation  = ANY($3::text[])
       LIMIT  5`,
            [tenantId, object, [...validRelations]]
        )

        if ((result.rowCount ?? 0) === 0) {
            return [`Ask an admin to grant ${action} access to ${object}`]
        }

        const fixes: string[] = []
        for (const row of result.rows) {
            if (row.subject.startsWith('group:')) {
                fixes.push(`Add ${subject} to ${row.subject} to gain ${action} access`)
            } else {
                fixes.push(`Ask an admin to assign ${subject} as ${row.relation} on ${object} directly`)
            }
        }

        const directRelation = validRelations[0]
        fixes.push(`Or assign ${subject} as ${directRelation} on ${object} directly`)

        return fixes
    } catch (error) {
        // buildSuggestedFix MUST NOT fail the main request — return safe fallback
        logger.error({ error: (error as Error).message }, 'build_suggested_fix_failed')
        return [`Ask an admin to grant ${action} access to ${object}`]
    }
}
