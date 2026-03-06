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
 * Escapes HTML special characters in user-controlled values before
 * interpolating them into suggestedFix / reason strings.
 *
 * Subject/object/relation names come from tuple data and are attacker-controlled.
 * If a caller renders these strings as innerHTML without upstream escaping,
 * this function prevents stored XSS.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
}

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
 * All user-controlled values are HTML-escaped.
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
    const s = escapeHtml(subject)
    const o = escapeHtml(object)
    const a = escapeHtml(action)
    if (!objectExists) return `Resource ${o} does not exist`
    if (limitHit === 'depth') return `Relationship graph exceeded depth limit — possible misconfiguration`
    if (limitHit === 'nodes') return `Relationship graph exceeded node limit — possible misconfiguration`
    if (found) return `Access granted — valid relationship found between ${s} and ${o}`
    return `No valid relationship found between ${s} and ${o} for action: ${a}`
}

/**
 * Queries which groups already have access to `object` and returns
 * plain-English suggestions for how to grant access to `subject`.
 *
 * Returns a safe fallback on any error — must never throw.
 * All user-controlled values are HTML-escaped before interpolation.
 */
export async function buildSuggestedFix(
    tenantId: string,
    subject: string,
    object: string,
    action: string,
): Promise<string[]> {
    const s = escapeHtml(subject)
    const o = escapeHtml(object)
    const a = escapeHtml(action)

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
            return [`Ask an admin to grant ${a} access to ${o}`]
        }

        const fixes: string[] = []
        for (const row of result.rows) {
            const rowSubject = escapeHtml(row.subject)
            const rowRelation = escapeHtml(row.relation)
            if (row.subject.startsWith('group:')) {
                fixes.push(`Add ${s} to ${rowSubject} to gain ${a} access`)
            } else {
                fixes.push(`Ask an admin to assign ${s} as ${rowRelation} on ${o} directly`)
            }
        }

        const directRelation = escapeHtml(validRelations[0] ?? 'owner')
        fixes.push(`Or assign ${s} as ${directRelation} on ${o} directly`)

        return fixes
    } catch (error) {
        // buildSuggestedFix MUST NOT fail the main request — return safe fallback
        logger.error({ error: (error as Error).message }, 'build_suggested_fix_failed')
        return [`Ask an admin to grant ${a} access to ${o}`]
    }
}
