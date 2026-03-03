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

export type QueueItem = {
    node: string
    depth: number
}

/**
 * Maps each action to the set of relations that grant that action.
 * Read is most permissive. Delete/manage require owner.
 *
 * This is the policy engine's core rule set for Phase 1.
 * Phase 2 replaces this with a compiled policy engine.
 */
export const ACTION_RELATION_MAP = {
    read: ['viewer', 'editor', 'owner'] as const,
    edit: ['editor', 'owner'] as const,
    delete: ['owner'] as const,
    manage: ['owner'] as const,
} as const

export type Action = keyof typeof ACTION_RELATION_MAP
export type ValidRelations = (typeof ACTION_RELATION_MAP)[Action][number]
