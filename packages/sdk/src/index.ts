/**
 * @runeauth/sdk — Rune Authorization SDK
 *
 * @example
 * ```ts
 * import { Rune } from '@runeauth/sdk'
 *
 * const rune = new Rune({ apiKey: 'your-key', baseUrl: 'http://localhost:4078' })
 *
 * const permission = await rune.can('user:arjun').do('read').on('shipment:TN001')
 * if (permission.status === 'ALLOW') { ... }
 * ```
 */
import { RuneClient } from './client.js'
import { SubjectBuilder } from './fluent.js'
import { createProtectMiddleware, type MiddlewareConfig, type MiddlewareFn } from './middleware.js'
import type { RuneOptions } from './types.js'

export class Rune {
    private readonly client: RuneClient

    readonly check: RuneClient['check']
    readonly allow: RuneClient['allow']
    readonly revoke: RuneClient['revoke']
    readonly logs: RuneClient['logs']
    readonly health: RuneClient['health']

    constructor(options: RuneOptions) {
        this.client = new RuneClient(options)
        this.check = this.client.check.bind(this.client)
        this.allow = this.client.allow.bind(this.client)
        this.revoke = this.client.revoke.bind(this.client)
        this.logs = this.client.logs.bind(this.client)
        this.health = this.client.health.bind(this.client)
    }

    /**
     * Start a fluent permission check.
     * @example rune.can('user:arjun').do('read').on('shipment:TN001')
     */
    can(subject: string): SubjectBuilder {
        return new SubjectBuilder(this.client, subject)
    }

    /**
     * Create route protection middleware.
     *
     * @example
     * ```ts
     * // Express
     * app.get('/docs/:id', rune.protect('read', 'document:{{params.id}}'), handler)
     *
     * // Custom subject extraction
     * app.get('/docs/:id', rune.protect('read', 'document:{{params.id}}', {
     *   subjectFrom: 'auth.userId',
     *   subjectPrefix: 'user:',
     * }), handler)
     * ```
     */
    protect(action: string, objectTemplate: string, config?: MiddlewareConfig): MiddlewareFn {
        return createProtectMiddleware(this.client, action, objectTemplate, config)
    }
}

// Re-export everything so users only need to import from '@runeauth/sdk'
export { RuneClient, RuneError } from './client.js'
export { createProtectMiddleware } from './middleware.js'
export type {
    RuneOptions,
    CacheStrategy,
    Permission,
    Grant,
    GrantResult,
    Audit,
    AuditLog,
    HealthStatus,
    Action,
} from './types.js'
export type { MiddlewareConfig, MiddlewareFn } from './middleware.js'
