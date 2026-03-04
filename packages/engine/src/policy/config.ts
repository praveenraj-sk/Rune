/**
 * Policy engine — loads rune.config.yml, validates it, resolves role inheritance.
 *
 * This replaces the hardcoded DEFAULT_ACTION_RELATIONS map.
 * Now roles and actions are defined in the config file, version-controlled in the repo.
 *
 * Role inheritance example:
 *   admin { inherits: [editor], actions: [delete] }
 *   editor { inherits: [viewer], actions: [edit] }
 *   viewer { actions: [read] }
 *
 * Resolved:
 *   admin.resolvedActions = [delete, edit, read]
 *   editor.resolvedActions = [edit, read]
 *   viewer.resolvedActions = [read]
 *
 * actionToRoles:
 *   read   → [viewer, editor, admin]
 *   edit   → [editor, admin]
 *   delete → [admin]
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { logger } from '../logger/index.js'
import type { RuneConfig, ResolvedPolicy, ResolvedResource, ResolvedRole } from './types.js'

let resolvedPolicy: ResolvedPolicy | null = null

/**
 * Load and resolve the policy from rune.config.yml.
 * Called once at engine startup.
 */
export function loadPolicy(configPath?: string): ResolvedPolicy {
    const path = configPath ?? findConfigFile()
    if (!path) {
        logger.warn('no rune.config.yml found — using default policy')
        resolvedPolicy = getDefaultPolicy()
        return resolvedPolicy
    }

    try {
        const raw = readFileSync(path, 'utf-8')
        const parsed = yaml.load(raw) as RuneConfig
        validate(parsed)
        resolvedPolicy = resolve(parsed)
        logger.info({ path, resources: Object.keys(resolvedPolicy.resources) }, 'policy_loaded')
        return resolvedPolicy
    } catch (error) {
        logger.error({ error: (error as Error).message, path }, 'policy_load_failed')
        throw new Error(`Failed to load rune.config.yml: ${(error as Error).message}`)
    }
}

/**
 * Get the current resolved policy. Must call loadPolicy() first.
 */
export function getPolicy(): ResolvedPolicy {
    if (!resolvedPolicy) {
        resolvedPolicy = getDefaultPolicy()
    }
    return resolvedPolicy
}

/**
 * Get the roles that grant a given action, considering role inheritance.
 * This replaces the old hardcoded getValidRelations().
 *
 * @param action   - e.g. "read", "edit", "delete"
 * @param resource - e.g. "document", "project" (optional — extracted from object like "doc:123")
 */
export function getValidRelations(action: string, resource?: string): readonly string[] {
    const policy = getPolicy()

    // If resource is provided, look up its specific config
    if (resource && policy.resources[resource]) {
        const res = policy.resources[resource]
        if (res.actionToRoles[action]) {
            return res.actionToRoles[action]
        }
    }

    // Check ALL resources for the action (when resource type unknown)
    const roles = new Set<string>()
    for (const res of Object.values(policy.resources)) {
        if (res.actionToRoles[action]) {
            for (const role of res.actionToRoles[action]) {
                roles.add(role)
            }
        }
    }

    if (roles.size > 0) return [...roles]

    // Fallback: custom action → match as relation name + owner (backward compat)
    return [action, 'owner']
}

/**
 * Extract resource type from an object identifier.
 * e.g. "doc:123" → "doc", "project:alpha" → "project"
 */
export function extractResourceType(object: string): string | undefined {
    const colonIndex = object.indexOf(':')
    if (colonIndex > 0) return object.substring(0, colonIndex)
    return undefined
}

// ── Validation ──────────────────────────────────────────────

function validate(config: RuneConfig): void {
    if (!config.version || config.version !== 1) {
        throw new Error('config must have version: 1')
    }
    if (!config.resources || typeof config.resources !== 'object') {
        throw new Error('config must have resources')
    }
    for (const [resName, res] of Object.entries(config.resources)) {
        if (!res.roles || typeof res.roles !== 'object') {
            throw new Error(`resource "${resName}" must have roles`)
        }
        for (const [roleName, role] of Object.entries(res.roles)) {
            if (!Array.isArray(role.actions)) {
                throw new Error(`role "${roleName}" in resource "${resName}" must have actions array`)
            }
            if (role.inherits !== undefined && !Array.isArray(role.inherits)) {
                throw new Error(`role "${roleName}" inherits must be an array`)
            }
            // Check inherited roles exist
            if (role.inherits) {
                for (const parent of role.inherits) {
                    if (!res.roles[parent]) {
                        throw new Error(`role "${roleName}" inherits "${parent}" which does not exist in resource "${resName}"`)
                    }
                }
            }
        }
    }
}

// ── Resolve inheritance ─────────────────────────────────────

function resolve(config: RuneConfig): ResolvedPolicy {
    const resources: Record<string, ResolvedResource> = {}

    for (const [resName, resDef] of Object.entries(config.resources)) {
        const resolvedRoles: Record<string, ResolvedRole> = {}

        // Resolve each role's actions including inherited ones
        for (const roleName of Object.keys(resDef.roles)) {
            resolvedRoles[roleName] = resolveRole(roleName, resDef.roles, new Set())
        }

        // Build reverse map: action → roles that grant it
        const actionToRoles: Record<string, string[]> = {}
        for (const [roleName, role] of Object.entries(resolvedRoles)) {
            for (const action of role.resolvedActions) {
                if (!actionToRoles[action]) actionToRoles[action] = []
                actionToRoles[action].push(roleName)
            }
        }

        resources[resName] = { name: resName, roles: resolvedRoles, actionToRoles }
    }

    return { resources }
}

function resolveRole(
    roleName: string,
    allRoles: Record<string, { actions: string[]; inherits?: string[] }>,
    visited: Set<string>,
): ResolvedRole {
    // Circular inheritance detection
    if (visited.has(roleName)) {
        throw new Error(`circular role inheritance detected: ${[...visited, roleName].join(' → ')}`)
    }
    visited.add(roleName)

    const roleDef = allRoles[roleName]
    if (!roleDef) throw new Error(`role "${roleName}" not found`)

    const ownActions = [...roleDef.actions]
    const allActions = new Set(ownActions)

    // Recursively resolve inherited roles
    const inherits = roleDef.inherits ?? []
    for (const parentName of inherits) {
        const parent = resolveRole(parentName, allRoles, new Set(visited))
        for (const action of parent.resolvedActions) {
            allActions.add(action)
        }
    }

    return {
        name: roleName,
        actions: ownActions,
        resolvedActions: [...allActions],
        inherits,
    }
}

// ── Defaults (backward compatibility) ───────────────────────

function getDefaultPolicy(): ResolvedPolicy {
    return resolve({
        version: 1,
        resources: {
            default: {
                roles: {
                    owner: { actions: ['read', 'edit', 'delete', 'manage'] },
                    editor: { inherits: ['viewer'], actions: ['edit'] },
                    viewer: { actions: ['read'] },
                },
            },
        },
    })
}

// ── Config file discovery ───────────────────────────────────

function findConfigFile(): string | null {
    const candidates = [
        join(process.cwd(), 'rune.config.yml'),
        join(process.cwd(), 'rune.config.yaml'),
        join(process.cwd(), '..', '..', 'rune.config.yml'),    // monorepo root
        join(process.cwd(), '..', '..', 'rune.config.yaml'),
    ]
    for (const p of candidates) {
        if (existsSync(p)) return p
    }
    return null
}
