/**
 * Shared types for BFS graph traversal.
 */

export type TraversalResult = {
    found: boolean
    objectExists: boolean
    path: string[]      // nodes visited in order (for trace/explainability)
    nodeCount: number
    depthReached: number
    limitHit: 'depth' | 'nodes' | null
}

/**
 * Get the valid relations that grant a given action.
 *
 * Now powered by rune.config.yml policy engine (with role inheritance).
 * Falls back to backward-compatible defaults if no config is found.
 *
 * Re-exported from policy/config.ts to keep the import path stable
 * for traverse.ts and any other consumers.
 */
export { getValidRelations } from '../policy/config.js'
