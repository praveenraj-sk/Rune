/**
 * RuneEngine — the embedded authorization engine.
 *
 * Supports per-resource execution modes via rune.config.yml:
 *   - rebac  (default) — BFS graph traversal → ABAC
 *   - rbac             — one-hop direct role check → ABAC
 *   - abac             — conditions only (no tuples)
 *   - hybrid           — RBAC fast-path → BFS fallback → ABAC
 *
 * @example
 * ```ts
 * import { RuneEngine, MemoryStore } from '@runeauth/core'
 *
 * const engine = new RuneEngine({
 *   store: new MemoryStore(),
 *   config: './rune.config.yml',
 * })
 *
 * await engine.allow({ subject: 'user:arjun', relation: 'editor', object: 'doc:readme', tenantId: 'default' })
 *
 * const result = await engine.can('user:arjun', 'read', 'doc:readme', 'default')
 * // result.decision  === 'allow'
 * // result.mode_used === 'rebac'
 * ```
 */
import type { TupleStore, Tuple } from './store/types.js'
import type { DataSource } from './datasource/types.js'
import { HybridStore } from './hybrid.js'
import { traverse, type BfsOptions } from './bfs.js'
import { evalRbac } from './evaluators/rbac.js'
import {
    loadPolicy,
    getValidRelationsFromPolicy,
    type ResolvedPolicy,
    type RuneConfig,
    type ResourceMode,
    type ConditionDef,
} from './policy.js'
import { evaluateConditions, allConditionsPassed, type EvalContext, type ConditionResult } from './conditions.js'

export type EngineOptions = {
    store: TupleStore
    config?: string | RuneConfig
    bfs?: BfsOptions
    /** Zero-Sync: datasources that read from your app's existing DB */
    dataSources?: DataSource[]
}

export type CanResult = {
    decision: 'allow' | 'deny'
    status: 'ALLOW' | 'DENY' | 'NOT_FOUND'
    reason: string
    trace: string[]
    condition_results: ConditionResult[]
    /** Which execution mode was used — rebac | rbac | abac | hybrid */
    mode_used: ResourceMode
    latency_ms: number
}

export class RuneEngine {
    private readonly store: TupleStore
    private readonly policy: ResolvedPolicy
    private readonly bfsOptions: BfsOptions

    constructor(options: EngineOptions) {
        this.store = options.dataSources && options.dataSources.length > 0
            ? new HybridStore(options.store, options.dataSources)
            : options.store
        this.policy = loadPolicy(options.config)
        this.bfsOptions = options.bfs ?? {}
    }

    /**
     * Check if subject can perform action on object.
     * Execution mode is determined by resource's `mode` in rune.config.yml.
     */
    async can(
        subject: string,
        action: string,
        object: string,
        tenantId = 'default',
        context?: EvalContext,
    ): Promise<CanResult> {
        const start = performance.now()

        try {
            const resourceType = this.extractResourceType(object)
            const resourceConfig = resourceType ? this.policy.resources[resourceType] : undefined
            const mode: ResourceMode = resourceConfig?.mode ?? 'rebac'
            const validRelations = getValidRelationsFromPolicy(this.policy, action, resourceType)

            // ── Mode routing ─────────────────────────────────────────────────

            if (mode === 'abac') {
                return this.abacOnly(subject, action, object, resourceConfig?.conditions, context, mode, start)
            }

            if (mode === 'rbac') {
                const r = await evalRbac(this.store, tenantId, subject, object, validRelations)
                if (!r.objectExists) return this.notFound(object, mode, start)
                if (!r.found) return this.deny(subject, action, object, r.path, [], mode, start)
                return this.allowOrAbac(subject, action, object, r.path, resourceConfig?.conditions, context, mode, start)
            }

            if (mode === 'hybrid') {
                const r = await evalRbac(this.store, tenantId, subject, object, validRelations)
                if (!r.objectExists) return this.notFound(object, mode, start)
                if (r.found) {
                    return this.allowOrAbac(subject, action, object, r.path, resourceConfig?.conditions, context, mode, start)
                }
                // Fallback to full BFS
                const bfs = await traverse(this.store, tenantId, subject, object, validRelations, this.bfsOptions)
                if (!bfs.found) return this.deny(subject, action, object, bfs.path, [], mode, start)
                return this.allowOrAbac(subject, action, object, bfs.path, resourceConfig?.conditions, context, mode, start)
            }

            // mode === 'rebac' (default)
            const bfs = await traverse(this.store, tenantId, subject, object, validRelations, this.bfsOptions)
            if (!bfs.objectExists) return this.notFound(object, mode, start)
            if (!bfs.found) return this.deny(subject, action, object, bfs.path, [], mode, start)
            return this.allowOrAbac(subject, action, object, bfs.path, resourceConfig?.conditions, context, mode, start)

        } catch {
            return {
                decision: 'deny',
                status: 'DENY',
                reason: 'engine error — fail closed',
                trace: [],
                condition_results: [],
                mode_used: 'rebac',
                latency_ms: performance.now() - start,
            }
        }
    }

    /** Add a relationship (grant access). */
    async allow(tuple: Tuple): Promise<void> { await this.store.add(tuple) }

    /** Remove a relationship (revoke access). */
    async revoke(tuple: Tuple): Promise<void> { await this.store.remove(tuple) }

    /** List tuples in the store. */
    async list(tenantId = 'default', options?: { limit?: number; offset?: number; search?: string }) {
        return this.store.list(tenantId, options)
    }

    /** Get the resolved policy (for debugging/display). */
    getPolicy(): ResolvedPolicy { return this.policy }

    // ── Private helpers ───────────────────────────────────────────────────────

    private allowOrAbac(
        subject: string, action: string, object: string,
        path: string[],
        conditions: Record<string, ConditionDef> | undefined,
        context: EvalContext | undefined,
        mode: ResourceMode, start: number,
    ): CanResult {
        const cr = evaluateConditions(conditions, action, context ?? {})
        const ok = allConditionsPassed(cr)
        return {
            decision: ok ? 'allow' : 'deny',
            status: ok ? 'ALLOW' : 'DENY',
            reason: ok
                ? `${subject} can ${action} on ${object} via path: ${path.join(' → ')}`
                : `ABAC conditions failed: ${cr.filter(c => !c.passed).map(c => `${c.name}: ${c.reason}`).join('; ')}`,
            trace: path,
            condition_results: cr,
            mode_used: mode,
            latency_ms: performance.now() - start,
        }
    }

    private abacOnly(
        subject: string, action: string, object: string,
        conditions: Record<string, ConditionDef> | undefined,
        context: EvalContext | undefined,
        mode: ResourceMode, start: number,
    ): CanResult {
        if (!conditions || Object.keys(conditions).length === 0) {
            return {
                decision: 'deny', status: 'DENY',
                reason: 'mode:abac but no conditions defined — deny by default',
                trace: [], condition_results: [], mode_used: mode,
                latency_ms: performance.now() - start,
            }
        }
        const cr = evaluateConditions(conditions, action, context ?? {})
        const ok = allConditionsPassed(cr)
        return {
            decision: ok ? 'allow' : 'deny',
            status: ok ? 'ALLOW' : 'DENY',
            reason: ok
                ? `${subject} can ${action} on ${object} — all conditions passed`
                : `ABAC: ${cr.filter(c => !c.passed).map(c => `${c.name}: ${c.reason}`).join('; ')}`,
            trace: [], condition_results: cr, mode_used: mode,
            latency_ms: performance.now() - start,
        }
    }

    private notFound(object: string, mode: ResourceMode, start: number): CanResult {
        return {
            decision: 'deny', status: 'NOT_FOUND',
            reason: `object "${object}" not found in store`,
            trace: [], condition_results: [], mode_used: mode,
            latency_ms: performance.now() - start,
        }
    }

    private deny(
        subject: string, action: string, object: string,
        path: string[], cr: ConditionResult[],
        mode: ResourceMode, start: number,
    ): CanResult {
        return {
            decision: 'deny', status: 'DENY',
            reason: `no valid ${mode} path from ${subject} to ${object} for action: ${action}`,
            trace: path, condition_results: cr, mode_used: mode,
            latency_ms: performance.now() - start,
        }
    }

    private extractResourceType(object: string): string | undefined {
        const i = object.indexOf(':')
        return i > 0 ? object.substring(0, i) : undefined
    }
}
