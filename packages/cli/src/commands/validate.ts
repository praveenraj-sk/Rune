/**
 * rune validate — validate rune.config.yml
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

type RoleConfig = { actions?: string[]; inherits?: string[] }
type ResourceConfig = { roles?: Record<string, RoleConfig> }
type Config = { version?: number; resources?: Record<string, ResourceConfig> }

export async function validate(): Promise<void> {
    const configPath = findConfig()
    if (!configPath) {
        console.log('  ✗ No rune.config.yml found\n')
        console.log('  Run: rune init\n')
        process.exit(1)
    }

    console.log(`\n  Validating ${configPath}...\n`)

    const raw = readFileSync(configPath, 'utf-8')
    let config: Config

    try {
        config = yaml.load(raw) as Config
    } catch (e) {
        console.log(`  ✗ Invalid YAML: ${(e as Error).message}\n`)
        process.exit(1)
    }

    const errors: string[] = []
    const warnings: string[] = []

    // Version check
    if (config.version !== 1) {
        errors.push('Missing or invalid version (must be 1)')
    }

    // Resources check
    if (!config.resources || typeof config.resources !== 'object') {
        errors.push('Missing resources section')
    } else {
        for (const [resName, res] of Object.entries(config.resources)) {
            if (!res.roles || typeof res.roles !== 'object') {
                errors.push(`Resource "${resName}": missing roles`)
                continue
            }

            const roleNames = Object.keys(res.roles)

            for (const [roleName, role] of Object.entries(res.roles)) {
                // Actions check
                if (!Array.isArray(role.actions) || role.actions.length === 0) {
                    errors.push(`Role "${roleName}" in "${resName}": must have at least one action`)
                }

                // Inherits check
                if (role.inherits) {
                    if (!Array.isArray(role.inherits)) {
                        errors.push(`Role "${roleName}" in "${resName}": inherits must be an array`)
                    } else {
                        for (const parent of role.inherits) {
                            if (!roleNames.includes(parent)) {
                                errors.push(`Role "${roleName}" in "${resName}": inherits "${parent}" which doesn't exist`)
                            }
                        }
                    }
                }

                // Circular inheritance check
                if (role.inherits) {
                    const visited = new Set<string>()
                    const circular = checkCircular(roleName, res.roles as Record<string, RoleConfig>, visited)
                    if (circular) {
                        errors.push(`Circular inheritance: ${circular}`)
                    }
                }
            }

            // Warning: no actions reachable
            if (roleNames.length === 0) {
                warnings.push(`Resource "${resName}": has no roles defined`)
            }
        }
    }

    // Print resolved roles
    if (errors.length === 0 && config.resources) {
        console.log('  Resolved roles:\n')
        for (const [resName, res] of Object.entries(config.resources)) {
            console.log(`  ${resName}:`)
            if (!res.roles) continue
            for (const [roleName, role] of Object.entries(res.roles)) {
                const resolved = resolveActions(roleName, res.roles as Record<string, RoleConfig>, new Set())
                const own = role.actions?.join(', ') ?? ''
                const inherited = resolved.filter(a => !role.actions?.includes(a))
                let line = `    ${roleName}: [${own}]`
                if (inherited.length > 0) {
                    line += ` + inherited: [${inherited.join(', ')}]`
                }
                console.log(line)
            }
            console.log()
        }
    }

    // Print results
    if (errors.length > 0) {
        console.log('  Errors:')
        for (const e of errors) console.log(`    ✗ ${e}`)
        console.log()
        process.exit(1)
    }

    if (warnings.length > 0) {
        console.log('  Warnings:')
        for (const w of warnings) console.log(`    ⚠ ${w}`)
        console.log()
    }

    console.log('  ✓ Config is valid\n')
}

function checkCircular(role: string, roles: Record<string, RoleConfig>, visited: Set<string>): string | null {
    if (visited.has(role)) return [...visited, role].join(' → ')
    visited.add(role)
    const def = roles[role]
    if (def?.inherits) {
        for (const parent of def.inherits) {
            const result = checkCircular(parent, roles, new Set(visited))
            if (result) return result
        }
    }
    return null
}

function resolveActions(role: string, roles: Record<string, RoleConfig>, visited: Set<string>): string[] {
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

function findConfig(): string | null {
    const candidates = ['rune.config.yml', 'rune.config.yaml']
    for (const c of candidates) {
        const p = join(process.cwd(), c)
        if (existsSync(p)) return p
    }
    return null
}
