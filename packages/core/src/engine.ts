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
import { traverse, type BfsOptions } from './bfs.js'
import { loadPolicy, getValidRelationsFromPolicy, type ResolvedPolicy, type RuneConfig } from './policy.js'
import { evaluateConditions, allConditionsPassed, type EvalContext, type ConditionResult } from './conditions.js'

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
    condition_results: ConditionResult[]
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
     * Three-pass evaluation: ReBAC (BFS) → RBAC (role inheritance) → ABAC (conditions).
     *
     * @param context - Optional ABAC context: { time, ip, resource: { status: ... } }
     */
    async can(subject: string, action: string, object: string, tenantId = 'default', context?: EvalContext): Promise<CanResult> {
        const start = performance.now()

        try {
            // Step 1 (ReBAC + RBAC): Get valid relations from config, run BFS
            const resourceType = this.extractResourceType(object)
            const validRelations = getValidRelationsFromPolicy(this.policy, action, resourceType)

            const result = await traverse(
                this.store,
                tenantId,
                subject,
                object,
                validRelations,
                this.bfsOptions,
            )

            if (!result.objectExists) {
                return {
                    decision: 'deny',
                    status: 'NOT_FOUND',
                    reason: `object "${object}" not found in store`,
                    trace: [],
                    condition_results: [],
                    latency_ms: performance.now() - start,
                }
            }

            if (!result.found) {
                return {
                    decision: 'deny',
                    status: 'DENY',
                    reason: `no path from ${subject} to ${object} with relations [${validRelations.join(', ')}]`,
                    trace: result.path,
                    condition_results: [],
                    latency_ms: performance.now() - start,
                }
            }

            // Step 2 (ABAC): Evaluate conditions from config
            const resourceConfig = resourceType ? this.policy.resources[resourceType] : undefined
            const conditionResults = evaluateConditions(
                resourceConfig?.conditions,
                action,
                context ?? {},
            )

            const conditionsPass = allConditionsPassed(conditionResults)

            return {
                decision: conditionsPass ? 'allow' : 'deny',
                status: conditionsPass ? 'ALLOW' : 'DENY',
                reason: conditionsPass
                    ? `${subject} can ${action} on ${object} via path: ${result.path.join(' → ')}`
                    : `ABAC conditions failed: ${conditionResults.filter(c => !c.passed).map(c => `${c.name}: ${c.reason}`).join('; ')}`,
                trace: result.path,
                condition_results: conditionResults,
                latency_ms: performance.now() - start,
            }
        } catch {
            return {
                decision: 'deny',
                status: 'DENY',
                reason: 'engine error — fail closed',
                trace: [],
                condition_results: [],
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
