/**
 * RBAC Evaluator — one-hop direct role check, no BFS.
 *
 * Used when a resource declares `mode: rbac` in rune.config.yml.
 * Instead of traversing the relationship graph, it checks a single tuple:
 *   does (subject, relation ∈ validRelations, object) exist in the store?
 *
 * This is O(1) at the store level — one query, no recursion, no graph traversal.
 * Ideal for flat "user has role on resource" models (e.g. report: admin/viewer).
 *
 * @example
 * ```yaml
 * # rune.config.yml
 * resources:
 *   report:
 *     mode: rbac
 *     roles:
 *       admin:  [read, edit, delete]
 *       viewer: [read]
 * ```
 */
import type { TupleStore } from '../store/types.js'

export type RbacResult = {
    found: boolean
    objectExists: boolean
    matchedRelation: string | null
    path: string[]
}

/**
 * One-hop RBAC check. Calls store.getEdges once with the subject and
 * checks if any returned edge directly connects to the target object
 * via a valid relation.
 */
export async function evalRbac(
    store: TupleStore,
    tenantId: string,
    subject: string,
    object: string,
    validRelations: readonly string[],
): Promise<RbacResult> {
    // Object existence check
    const exists = await store.objectExists(tenantId, object)
    if (!exists) {
        return { found: false, objectExists: false, matchedRelation: null, path: [] }
    }

    // One-hop: get all edges FROM this subject, look for direct match
    const edges = await store.getEdges(tenantId, [subject])
    for (const edge of edges) {
        if (edge.object === object && validRelations.includes(edge.relation)) {
            return {
                found: true,
                objectExists: true,
                matchedRelation: edge.relation,
                path: [subject, object],
            }
        }
    }

    return { found: false, objectExists: true, matchedRelation: null, path: [subject] }
}
