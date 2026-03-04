/**
 * BFS graph traversal for authorization decisions.
 *
 * Finds whether `subject` can reach `object` via valid relations for `action`.
 * Traverses the relationship graph in the tuples table, breadth-first.
 *
 * PERFORMANCE: Processes one full BFS depth level per DB query,
 * vs the naive approach of one query per node (N+1).
 * For a graph with 50 nodes across 5 depth levels → 5 queries, not 50.
 *
 * Safety guarantees:
 * - MAX_BFS_DEPTH stops runaway deep chains
 * - MAX_BFS_NODES stops runaway wide graphs
 * - visited Set prevents infinite loops from circular relationships
 * - object existence check fires first — never BFS for nonexistent resources
 */
import { config } from '../config/index.js'
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'
import {
    getValidRelations,
    type TraversalResult,
} from './types.js'

type TupleRow = {
    subject: string
    relation: string
    object: string
}

/**
 * Traverse the relationship graph using BFS, with batched DB queries per depth level.
 *
 * @param tenantId - Tenant scope — all DB queries filtered by this
 * @param subject  - Entity requesting access: "user:arjun"
 * @param object   - Target resource: "shipment:TN001"
 * @param action   - Requested action: any string (e.g. "read", "approve", "export")
 */
export async function traverse(
    tenantId: string,
    subject: string,
    object: string,
    action: string,
): Promise<TraversalResult> {
    // Step 1: Get valid relations for this action (supports custom actions)
    const validRelations = getValidRelations(action)

    // Step 2: Check the target object exists before doing any BFS
    // Distinguishes "doesn't exist" (NOT_FOUND) from "exists but no access" (DENY)
    const existsResult = await query(
        `SELECT 1 FROM tuples WHERE tenant_id = $1 AND object = $2 LIMIT 1`,
        [tenantId, object]
    )
    if ((existsResult.rowCount ?? 0) === 0) {
        logger.debug({ tenantId, object }, 'bfs_object_not_found')
        return { found: false, objectExists: false, path: [], nodeCount: 0, depthReached: 0, limitHit: null }
    }

    // Step 3: BFS initialisation — one "frontier" per depth level
    let frontier: string[] = [subject]       // nodes to expand at current depth
    const visited = new Set<string>([subject])
    const path: string[] = [subject]        // ordered list of nodes visited
    let nodeCount = 0
    let depth = 0

    // Step 4: BFS loop — one DB query per depth level (not per node)
    while (frontier.length > 0 && depth < config.bfs.maxDepth) {

        // Batch query: fetch all outgoing edges for the entire current frontier
        // Uses ANY($1::text[]) — single round-trip to DB per BFS depth
        const edgesResult = await query<TupleRow>(
            `SELECT subject, relation, object
             FROM   tuples
             WHERE  tenant_id = $1
               AND  subject   = ANY($2::text[])`,
            [tenantId, frontier]
        )

        const nextFrontier: string[] = []

        for (const edge of edgesResult.rows) {
            nodeCount++

            // Node limit safety check
            if (nodeCount >= config.bfs.maxNodes) {
                logger.warn({ tenantId, subject, object, nodeCount }, 'bfs_node_limit_hit')
                return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: 'nodes' }
            }

            // Early exit: found a valid access-granting edge to the target object
            if (edge.object === object && (validRelations as readonly string[]).includes(edge.relation)) {
                const fullPath = [...path, edge.object]
                logger.debug({ tenantId, subject, object, action, nodeCount, path: fullPath }, 'bfs_found')
                return {
                    found: true,
                    objectExists: true,
                    path: fullPath,
                    nodeCount,
                    depthReached: depth,
                    limitHit: null,
                }
            }

            // Add unvisited neighbor to next depth frontier
            if (!visited.has(edge.object)) {
                visited.add(edge.object)
                path.push(edge.object)
                nextFrontier.push(edge.object)
            }
        }

        frontier = nextFrontier
        depth++
    }

    // Depth limit hit
    if (depth >= config.bfs.maxDepth && frontier.length > 0) {
        logger.warn({ tenantId, subject, object, nodeCount }, 'bfs_depth_limit_hit')
        return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: 'depth' }
    }

    // Exhausted all reachable nodes — no valid path found
    logger.debug({ tenantId, subject, object, action, nodeCount }, 'bfs_not_found')
    return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: null }
}
