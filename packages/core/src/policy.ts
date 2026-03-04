/**
 * Policy resolver — loads rune.config.yml and resolves role inheritance.
 * Portable version for @runeauth/core (no logger dependency).
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

export type RoleDefinition = {
    actions: string[]
    inherits?: string[]
}

export type ResourceDefinition = {
    roles: Record<string, RoleDefinition>
}

export type RuneConfig = {
    version: number
    resources: Record<string, ResourceDefinition>
}

export type ResolvedPolicy = {
    resources: Record<string, {
        name: string
        roles: Record<string, { name: string; actions: string[]; resolvedActions: string[]; inherits: string[] }>
        actionToRoles: Record<string, string[]>
    }>
}

/**
 * Load and resolve policy from a YAML file or inline config.
 */
export function loadPolicy(configOrPath?: string | RuneConfig): ResolvedPolicy {
    let config: RuneConfig

    if (!configOrPath) {
        const path = findConfigFile()
        if (!path) return getDefaultPolicy()
        config = yaml.load(readFileSync(path, 'utf-8')) as RuneConfig
    } else if (typeof configOrPath === 'string') {
        if (!existsSync(configOrPath)) throw new Error(`Config file not found: ${configOrPath}`)
        config = yaml.load(readFileSync(configOrPath, 'utf-8')) as RuneConfig
    } else {
        config = configOrPath
    }

    return resolve(config)
}

export function getValidRelationsFromPolicy(policy: ResolvedPolicy, action: string, resourceType?: string): string[] {
    if (resourceType && policy.resources[resourceType]) {
        const res = policy.resources[resourceType]
        if (res.actionToRoles[action]) return res.actionToRoles[action]
    }

    // Check all resources
    const roles = new Set<string>()
    for (const res of Object.values(policy.resources)) {
        if (res.actionToRoles[action]) {
            for (const role of res.actionToRoles[action]) roles.add(role)
        }
    }

    return roles.size > 0 ? [...roles] : [action, 'owner']
}

function resolve(config: RuneConfig): ResolvedPolicy {
    const resources: ResolvedPolicy['resources'] = {}

    for (const [resName, resDef] of Object.entries(config.resources)) {
        const resolvedRoles: Record<string, { name: string; actions: string[]; resolvedActions: string[]; inherits: string[] }> = {}

        for (const roleName of Object.keys(resDef.roles)) {
            resolvedRoles[roleName] = resolveRole(roleName, resDef.roles, new Set())
        }

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
): { name: string; actions: string[]; resolvedActions: string[]; inherits: string[] } {
    if (visited.has(roleName)) throw new Error(`circular inheritance: ${[...visited, roleName].join(' → ')}`)
    visited.add(roleName)

    const roleDef = allRoles[roleName]
    if (!roleDef) throw new Error(`role "${roleName}" not found`)

    const ownActions = [...roleDef.actions]
    const allActions = new Set(ownActions)
    const inherits = roleDef.inherits ?? []

    for (const parentName of inherits) {
        const parent = resolveRole(parentName, allRoles, new Set(visited))
        for (const action of parent.resolvedActions) allActions.add(action)
    }

    return { name: roleName, actions: ownActions, resolvedActions: [...allActions], inherits }
}

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

function findConfigFile(): string | null {
    const candidates = [
        join(process.cwd(), 'rune.config.yml'),
        join(process.cwd(), 'rune.config.yaml'),
    ]
    for (const p of candidates) {
        if (existsSync(p)) return p
    }
    return null
}
