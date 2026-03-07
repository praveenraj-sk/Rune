import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

export type RoleConfig = { actions?: string[]; inherits?: string[] }
export type ResourceConfig = { roles?: Record<string, RoleConfig> }
export type Config = { version?: number; resources?: Record<string, ResourceConfig> }

export function findConfig(): string | null {
    const candidates = ['rune.config.yml', 'rune.config.yaml']
    for (const c of candidates) {
        const p = join(process.cwd(), c)
        if (existsSync(p)) return p
    }
    return null
}

export function loadConfig(configPath: string): Config {
    const raw = readFileSync(configPath, 'utf-8')
    return yaml.load(raw) as Config
}

export function resolveActions(role: string, roles: Record<string, RoleConfig>, visited: Set<string>): string[] {
    if (visited.has(role)) return []
    visited.add(role)
    const def = roles[role]
    if (!def) return []
    const actions = new Set(def.actions ?? [])
    if (def.inherits) {
        for (const parent of def.inherits) {
            for (const a of resolveActions(parent, roles, visited)) actions.add(a)
        }
    }
    return [...actions]
}

export function getInheritChain(role: string, action: string, roles: Record<string, RoleConfig>): string[] {
    const chain: string[] = [role]
    let current = role
    const visited = new Set<string>()

    while (true) {
        if (visited.has(current)) break
        visited.add(current)
        const def = roles[current]
        if (!def?.inherits) break

        let found = false
        for (const parent of def.inherits) {
            const parentDef = roles[parent]
            if (parentDef?.actions?.includes(action)) {
                chain.push(parent)
                return chain
            }
            const parentResolved = resolveActions(parent, roles, new Set())
            if (parentResolved.includes(action)) {
                chain.push(parent)
                current = parent
                found = true
                break
            }
        }
        if (!found) break
    }

    return chain
}
