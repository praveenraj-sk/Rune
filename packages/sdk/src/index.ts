/**
 * @runeauth/sdk — Rune Authorization SDK
 *
 * @example
 * ```ts
 * import { Rune } from '@runeauth/sdk'
 *
 * const rune = new Rune({ apiKey: 'your-key', baseUrl: 'http://localhost:4078' })
 *
 * // Fluent style
 * const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
 * if (result.status === 'ALLOW') { // ✅ serve the request }
 *
 * // Direct style
 * const result2 = await rune.check({ subject: 'user:arjun', action: 'read', object: 'shipment:TN001' })
 *
 * // Manage relationships
 * await rune.allow({ subject: 'user:arjun', relation: 'viewer',  object: 'invoice:001' })
 * await rune.revoke({ subject: 'user:arjun', relation: 'viewer', object: 'invoice:001' })
 * ```
 */
import { RuneClient, RuneError } from './client.js'
import { SubjectBuilder } from './fluent.js'
import type { RuneConfig, CanResult, TupleInput, TupleResult, LogsResult, HealthResult, Action } from './types.js'

export class Rune extends RuneClient {
    constructor(config: RuneConfig) {
        super(config)
    }

    /**
     * Start a fluent authorization check.
     *
     * @example
     * const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
     */
    can(subject: string): SubjectBuilder {
        return new SubjectBuilder(this, subject)
    }
}

// Re-export everything so users only need to import from '@runeauth/sdk'
export { RuneClient, RuneError }
export type { RuneConfig, CanResult, TupleInput, TupleResult, LogsResult, HealthResult, Action }
