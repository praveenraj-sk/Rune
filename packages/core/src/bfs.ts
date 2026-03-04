/**
 * Portable BFS engine — runs ANYWHERE (in-process, server, CLI).
 *
 * This is the same BFS algorithm from the engine, but decoupled from
 * Fastify, Postgres, and pino. It only depends on TupleStore interface.
 *
 * Performance: processes one full BFS depth level per store query,
 * not one query per node (N+1 prevention).
 */
import type { TupleStore } from './store/types.js'

export type TraversalResult = {
    found: boolean
    objectExists: boolean
    path: string[]
    nodeCount: number
    depthReached: number
    limitHit: 'depth' | 'nodes' | null
}

export type BfsOptions = {
    maxDepth?: number
    maxNodes?: number
}

const DEFAULT_MAX_DEPTH = 10
const DEFAULT_MAX_NODES = 1000

/**
 * BFS traversal using a pluggable TupleStore.
 */
export async function traverse(
    store: TupleStore,
    tenantId: string,
    subject: string,
    object: string,
    validRelations: readonly string[],
    options?: BfsOptions,
): Promise<TraversalResult> {
    const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES

    // Check object exists
    const exists = await store.objectExists(tenantId, object)
    if (!exists) {
        return { found: false, objectExists: false, path: [], nodeCount: 0, depthReached: 0, limitHit: null }
    }

    // BFS
    let frontier: string[] = [subject]
    const visited = new Set<string>([subject])
    const path: string[] = [subject]
    let nodeCount = 0
    let depth = 0

    while (frontier.length > 0 && depth < maxDepth) {
        const edges = await store.getEdges(tenantId, frontier)
        const nextFrontier: string[] = []

        for (const edge of edges) {
            nodeCount++

            if (nodeCount >= maxNodes) {
                return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: 'nodes' }
            }

            // Found valid access
            if (edge.object === object && validRelations.includes(edge.relation)) {
                return {
                    found: true,
                    objectExists: true,
                    path: [...path, edge.object],
                    nodeCount,
                    depthReached: depth,
                    limitHit: null,
                }
            }

            // Expand frontier
            if (!visited.has(edge.object)) {
                visited.add(edge.object)
                path.push(edge.object)
                nextFrontier.push(edge.object)
            }
        }

        frontier = nextFrontier
        depth++
    }

    // Depth limit
    if (depth >= maxDepth && frontier.length > 0) {
        return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: 'depth' }
    }

    return { found: false, objectExists: true, path, nodeCount, depthReached: depth, limitHit: null }
}
