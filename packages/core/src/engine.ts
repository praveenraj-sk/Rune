/**
 * RuneEngine — the embedded authorization engine.
 *
 * This is the heart of "Rune runs in your app".
 * No external server, no HTTP calls, no Render.
 * BFS runs in-process with pluggable storage.
 *
 * @example
 * ```ts
 * import { RuneEngine, MemoryStore } from '@runeauth/core'
 *
 * const engine = new RuneEngine({
 *   store: new MemoryStore(),
 *   config: './rune.config.yml',  // or inline config object
 * })
 *
 * await engine.allow({ subject: 'user:arjun', relation: 'editor', object: 'doc:readme', tenantId: 'default' })
 *
 * const result = await engine.can('user:arjun', 'read', 'doc:readme', 'default')
 * // result.decision === 'allow'
 * //   because editor inherits viewer, and viewer grants read
 * ```
 */
import type { TupleStore, Tuple } from './store/types.js'
import { traverse, type TraversalResult, type BfsOptions } from './bfs.js'
import { loadPolicy, getValidRelationsFromPolicy, type ResolvedPolicy, type RuneConfig } from './policy.js'

export type EngineOptions = {
    store: TupleStore
    config?: string | RuneConfig     // path to yaml file OR inline config
    bfs?: BfsOptions
}

export type CanResult = {
    decision: 'allow' | 'deny'
    status: 'ALLOW' | 'DENY' | 'NOT_FOUND'
    reason: string
    trace: string[]
    latency_ms: number
}

export class RuneEngine {
    private readonly store: TupleStore
    private readonly policy: ResolvedPolicy
    private readonly bfsOptions: BfsOptions

    constructor(options: EngineOptions) {
        this.store = options.store
        this.policy = loadPolicy(options.config)
        this.bfsOptions = options.bfs ?? {}
    }

    /**
     * Check if subject can perform action on object.
     */
    async can(subject: string, action: string, object: string, tenantId = 'default'): Promise<CanResult> {
        const start = performance.now()

        try {
            // Get valid relations from config
            const resourceType = this.extractResourceType(object)
            const validRelations = getValidRelationsFromPolicy(this.policy, action, resourceType)

            // Run BFS
            const result = await traverse(
                this.store,
                tenantId,
                subject,
                object,
                validRelations,
                this.bfsOptions,
            )

            const latency = performance.now() - start

            if (!result.objectExists) {
                return {
                    decision: 'deny',
                    status: 'NOT_FOUND',
                    reason: `object "${object}" not found in store`,
                    trace: [],
                    latency_ms: latency,
                }
            }

            return {
                decision: result.found ? 'allow' : 'deny',
                status: result.found ? 'ALLOW' : 'DENY',
                reason: result.found
                    ? `${subject} can ${action} on ${object} via path: ${result.path.join(' → ')}`
                    : `no path from ${subject} to ${object} with relations [${validRelations.join(', ')}]`,
                trace: result.path,
                latency_ms: latency,
            }
        } catch {
            return {
                decision: 'deny',
                status: 'DENY',
                reason: 'engine error — fail closed',
                trace: [],
                latency_ms: performance.now() - start,
            }
        }
    }

    /**
     * Add a relationship (grant access).
     */
    async allow(tuple: Tuple): Promise<void> {
        await this.store.add(tuple)
    }

    /**
     * Remove a relationship (revoke access).
     */
    async revoke(tuple: Tuple): Promise<void> {
        await this.store.remove(tuple)
    }

    /**
     * List tuples in the store.
     */
    async list(tenantId = 'default', options?: { limit?: number; offset?: number; search?: string }) {
        return this.store.list(tenantId, options)
    }

    /**
     * Get the resolved policy (for debugging/display).
     */
    getPolicy(): ResolvedPolicy {
        return this.policy
    }

    private extractResourceType(object: string): string | undefined {
        const colonIndex = object.indexOf(':')
        return colonIndex > 0 ? object.substring(0, colonIndex) : undefined
    }
}
