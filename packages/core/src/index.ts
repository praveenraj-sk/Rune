/**
 * @runeauth/core — portable authorization engine
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
 * // Grant access
 * await engine.allow({ subject: 'user:arjun', relation: 'editor', object: 'doc:readme', tenantId: 'default' })
 *
 * // Check access
 * const result = await engine.can('user:arjun', 'read', 'doc:readme')
 * // result.decision === 'allow' (editor inherits viewer → viewer grants read)
 * ```
 */

export { RuneEngine } from './engine.js'
export type { EngineOptions, CanResult } from './engine.js'

export { MemoryStore } from './store/memory.js'
export type { TupleStore, Tuple } from './store/types.js'

export { traverse } from './bfs.js'
export type { TraversalResult, BfsOptions } from './bfs.js'

export { loadPolicy, getValidRelationsFromPolicy } from './policy.js'
export type { ResolvedPolicy, RuneConfig, RoleDefinition, ResourceDefinition, ConditionDef } from './policy.js'

export { evaluateConditions, allConditionsPassed } from './conditions.js'
export type { EvalContext, ConditionResult } from './conditions.js'

export { SqlDataSource } from './datasource/sql.js'
export type { DataSource, DataSourceConfig, DataSourceMapping, ExternalTuple } from './datasource/types.js'

export { HybridStore } from './hybrid.js'
