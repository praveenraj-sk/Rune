/**
 * Permission Index — materialised O(1) permission lookup table.
 *
 * On every tuple write:
 *   - indexGrant(tuple, validActions) writes one row per implied action
 *   - removeGrant(tuple) deletes rows for that specific tuple
 *
 * On every can() call (between LRU cache and BFS):
 *   - checkIndex(tenantId, subject, action, object) → O(1) indexed lookup
 *
 * This means for most checks (especially rbac/hybrid resources) BFS
 * is never reached after the first write.
 *
 * Design decisions:
 * - `granted_by` = "{subject}|{relation}|{object}" — unambiguous tuple key
 * - ON CONFLICT DO NOTHING on insert — same permission can come from multiple tuples
 * - Deletion only removes rows matching that specific tuple's granted_by
 * - Index maintenance runs fire-and-forget (never blocks the write response)
 */
import { query } from './client.js'
import { logger } from '../logger/index.js'

export type IndexEntry = {
    tenantId: string
    subject: string
    action: string
    object: string
    grantedBy: string
}

/**
 * Build the granted_by key from a tuple — used as the foreign reference.
 */
export function grantedByKey(subject: string, relation: string, object: string): string {
    return `${subject}|${relation}|${object}`
}

/**
 * Write implied permissions to the index for a newly added tuple.
 * Called fire-and-forget from tuples POST route.
 *
 * @param tenantId    - Tenant scope
 * @param subject     - e.g. "user:arjun"
 * @param relation    - e.g. "editor"
 * @param object      - e.g. "doc:readme"
 * @param actions     - all actions that this relation grants (resolved from policy)
 */
export async function indexGrant(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
    actions: string[],
): Promise<void> {
    if (actions.length === 0) return

    const grantedBy = grantedByKey(subject, relation, object)

    try {
        // Batch insert all implied actions in one query
        const values = actions.map((_, i) => {
            const base = i * 5
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
        }).join(', ')

        const params: string[] = []
        for (const action of actions) {
            params.push(tenantId, subject, action, object, grantedBy)
        }

        await query(
            `INSERT INTO permission_index (tenant_id, subject, action, object, granted_by)
             VALUES ${values}
             ON CONFLICT (tenant_id, subject, action, object) DO NOTHING`,
            params,
        )

        logger.debug({ tenantId, subject, relation, object, actions: actions.length }, 'perm_index_grant')
    } catch (err) {
        // Index failure must never block writes — log and continue
        logger.warn({ err, tenantId, subject, relation, object }, 'perm_index_grant_failed')
    }
}

/**
 * Remove all permission_index entries that were created by a specific tuple.
 * Called fire-and-forget from tuples DELETE route.
 */
export async function removeGrant(
    tenantId: string,
    subject: string,
    relation: string,
    object: string,
): Promise<void> {
    const grantedBy = grantedByKey(subject, relation, object)

    try {
        await query(
            `DELETE FROM permission_index
             WHERE tenant_id = $1 AND granted_by = $2`,
            [tenantId, grantedBy],
        )
        logger.debug({ tenantId, subject, relation, object }, 'perm_index_remove')
    } catch (err) {
        logger.warn({ err, tenantId, subject, relation, object }, 'perm_index_remove_failed')
    }
}

/**
 * O(1) permission check against the materialised index.
 * Returns true if the permission is pre-computed in the index.
 *
 * Called in can() between the LRU cache hit and BFS traversal.
 */
export async function checkIndex(
    tenantId: string,
    subject: string,
    action: string,
    object: string,
): Promise<boolean> {
    try {
        const result = await query<{ exists: boolean }>(
            `SELECT EXISTS(
               SELECT 1 FROM permission_index
               WHERE tenant_id = $1
                 AND subject   = $2
                 AND action    = $3
                 AND object    = $4
             ) AS exists`,
            [tenantId, subject, action, object],
        )
        return result.rows[0]?.exists === true
    } catch (err) {
        // If index check fails, fall through to BFS — never deny due to index failure
        logger.warn({ err, tenantId, subject, action, object }, 'perm_index_check_failed')
        return false
    }
}

/**
 * Wipe all index entries for a tenant. Called alongside cache.deleteByTenant()
 * when a tuple is deleted and we can't cheaply determine the impact.
 * (Used as a safety valve — not the primary deletion path.)
 */
export async function clearTenantIndex(tenantId: string): Promise<void> {
    try {
        await query(`DELETE FROM permission_index WHERE tenant_id = $1`, [tenantId])
        logger.debug({ tenantId }, 'perm_index_tenant_cleared')
    } catch (err) {
        logger.warn({ err, tenantId }, 'perm_index_clear_failed')
    }
}
