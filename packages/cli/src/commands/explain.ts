/**
 * rune explain <subject> <action> <object>
 *
 * Traces exactly WHY a permission decision is made.
 * Uses the rune.config.yml to resolve roles and actions locally.
 *
 * Example:
 *   rune explain user:arjun read document:readme
 *
 * Output:
 *   ✓ ALLOW — user:arjun can read document:readme
 *
 *   Trace:
 *     1. Looking for: who can "read" on resource type "document"?
 *     2. Roles that grant "read": [viewer, editor, owner]
 *     3. Role "viewer" grants: [read]
 *     4. Role "editor" grants: [edit, share] + inherits viewer → [read]
 *     5. Role "owner" grants: [read, edit, delete, share]
 *
 *   To allow user:arjun to read document:readme, add one of:
 *     rune.allow({ subject: 'user:arjun', relation: 'viewer', object: 'document:readme' })
 *     rune.allow({ subject: 'user:arjun', relation: 'editor', object: 'document:readme' })
 *     rune.allow({ subject: 'user:arjun', relation: 'owner', object: 'document:readme' })
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

type RoleConfig = { actions?: string[]; inherits?: string[] }
type ResourceConfig = { roles?: Record<string, RoleConfig> }
type Config = { version?: number; resources?: Record<string, ResourceConfig> }

export async function explain(args: string[]): Promise<void> {
    // Parse --tenant flag
    const tenantIdx = args.indexOf('--tenant')
    let tenant = 'default'
    const cleanArgs = [...args]
    if (tenantIdx !== -1) {
        tenant = args[tenantIdx + 1] ?? 'default'
        cleanArgs.splice(tenantIdx, 2)
    }

    if (cleanArgs.length < 3) {
        console.log('\n  Usage: rune explain <subject> <action> <object> [--tenant <id>]')
        console.log('  Example: rune explain user:arjun read document:readme --tenant org:acme\n')
        process.exit(1)
    }

    const [subject, action, object] = cleanArgs as [string, string, string]
    const resourceType = object.includes(':') ? object.split(':')[0] : undefined

    // Load config
    const configPath = findConfig()
    if (!configPath) {
        console.log('  ✗ No rune.config.yml found. Run: rune init\n')
        process.exit(1)
    }

    const config = yaml.load(readFileSync(configPath, 'utf-8')) as Config
    if (!config.resources) {
        console.log('  ✗ No resources defined in config\n')
        process.exit(1)
    }

    console.log(`\n  ╭──────────────────────────────────────╮`)
    console.log(`  │  rune explain                        │`)
    console.log(`  ╰──────────────────────────────────────╯\n`)
    if (tenant !== 'default') {
        console.log(`  Tenant: ${tenant}`)
    }
    console.log(`  Query: can ${subject} do "${action}" on ${object}?\n`)

    // Find resource
    const resource = resourceType ? config.resources[resourceType] : undefined

    if (!resource) {
        console.log(`  ✗ Resource type "${resourceType}" not found in config\n`)
        console.log(`  Available resources: ${Object.keys(config.resources).join(', ')}\n`)

        if (resourceType) {
            console.log(`  Hint: Add this to your rune.config.yml:\n`)
            console.log(`    ${resourceType}:`)
            console.log(`      roles:`)
            console.log(`        viewer:`)
            console.log(`          actions: [${action}]\n`)
        }
        return
    }

    if (!resource.roles) {
        console.log(`  ✗ No roles defined for "${resourceType}"\n`)
        return
    }

    // Find which roles grant this action
    const grantingRoles: Array<{ name: string; direct: boolean; inheritChain: string[] }> = []

    for (const [roleName, roleDef] of Object.entries(resource.roles)) {
        const resolvedActions = resolveActions(roleName, resource.roles as Record<string, RoleConfig>, new Set())
        if (resolvedActions.includes(action)) {
            const isDirect = roleDef.actions?.includes(action) ?? false
            const chain = isDirect ? [] : getInheritChain(roleName, action, resource.roles as Record<string, RoleConfig>)
            grantingRoles.push({ name: roleName, direct: isDirect, inheritChain: chain })
        }
    }

    // Print trace
    console.log('  Trace:')
    console.log(`    1. Resource type: "${resourceType}"`)
    console.log(`    2. Action requested: "${action}"`)

    if (grantingRoles.length === 0) {
        console.log(`    3. No roles grant "${action}" on "${resourceType}"`)
        console.log(`\n  ✗ DENY — no role grants "${action}"\n`)
        console.log(`  Fix: Add "${action}" to a role in rune.config.yml:\n`)
        console.log(`    ${resourceType}:`)
        console.log(`      roles:`)
        console.log(`        viewer:`)
        console.log(`          actions: [${action}]\n`)
        return
    }

    console.log(`    3. Roles that grant "${action}":`)
    for (const role of grantingRoles) {
        if (role.direct) {
            console.log(`       → ${role.name} (directly grants "${action}")`)
        } else {
            console.log(`       → ${role.name} (inherits: ${role.inheritChain.join(' → ')})`)
        }
    }

    console.log(`\n  Result:`)
    console.log(`    If ${subject} has ANY of these relations on ${object},`)
    console.log(`    the request will be ALLOWED:\n`)

    for (const role of grantingRoles) {
        console.log(`      rune.allow({ subject: '${subject}', relation: '${role.name}', object: '${object}', tenantId: '${tenant}' })`)
    }

    // Print full role resolution
    console.log(`\n  Full role map for "${resourceType}":\n`)
    for (const [roleName, roleDef] of Object.entries(resource.roles)) {
        const resolved = resolveActions(roleName, resource.roles as Record<string, RoleConfig>, new Set())
        const own = roleDef.actions?.join(', ') ?? ''
        const inherited = resolved.filter(a => !(roleDef.actions ?? []).includes(a))
        let line = `    ${roleName}: [${own}]`
        if (inherited.length > 0) {
            line += ` + inherited: [${inherited.join(', ')}]`
        }
        const grantsAction = resolved.includes(action)
        line += grantsAction ? '  ← grants' : ''
        console.log(line)
    }
    console.log()
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

function getInheritChain(role: string, action: string, roles: Record<string, RoleConfig>): string[] {
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

function findConfig(): string | null {
    const candidates = ['rune.config.yml', 'rune.config.yaml']
    for (const c of candidates) {
        const p = join(process.cwd(), c)
        if (existsSync(p)) return p
    }
    return null
}
