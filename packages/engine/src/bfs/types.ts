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
 * Default built-in action → relation mapping.
 * These provide sensible defaults for standard CRUD operations.
 *
 * For CUSTOM actions (e.g. 'approve', 'export', 'share'):
 * The action name is matched directly as a relation.
 * So if you do rune.can('user:x').do('approve').on('doc:y'),
 * it will look for a tuple with relation = 'approve'.
 */
const DEFAULT_ACTION_RELATIONS: Record<string, readonly string[]> = {
    read: ['viewer', 'editor', 'owner'],
    edit: ['editor', 'owner'],
    delete: ['owner'],
    manage: ['owner'],
}

/**
 * Get the valid relations that grant a given action.
 * - Built-in actions (read/edit/delete/manage) use the default mapping.
 * - Custom actions match themselves as a relation name, plus 'owner' (owners can do everything).
 */
export function getValidRelations(action: string): readonly string[] {
    return DEFAULT_ACTION_RELATIONS[action] ?? [action, 'owner']
}

