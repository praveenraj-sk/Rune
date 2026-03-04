/**
 * Policy types — the shape of rune.config.yml after parsing.
 */

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

/**
 * Resolved role — after inheritance has been expanded.
 * e.g. admin { inherits: [editor] } → resolvedActions includes editor's + viewer's actions.
 */
export type ResolvedRole = {
    name: string
    actions: string[]           // own actions
    resolvedActions: string[]   // own + all inherited actions
    inherits: string[]
}

export type ResolvedResource = {
    name: string
    roles: Record<string, ResolvedRole>
    /** action → list of roles that grant it (after inheritance) */
    actionToRoles: Record<string, string[]>
}

export type ResolvedPolicy = {
    resources: Record<string, ResolvedResource>
}
