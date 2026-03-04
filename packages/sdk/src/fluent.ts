/**
 * Rune SDK — Fluent Builder
 *
 * Provides the ergonomic can('user:arjun').do('read').on('shipment:TN001') API.
 * Each step narrows the type so TypeScript catches missing fields at compile time.
 */
import type { RuneClient } from './client.js'
import type { Permission, Action } from './types.js'

/** Step 1: who */
export class SubjectBuilder {
    constructor(
        private readonly client: RuneClient,
        private readonly subject: string,
    ) { }

    /** Step 2: what action */
    do(action: Action): ActionBuilder {
        return new ActionBuilder(this.client, this.subject, action)
    }
}

/** Step 2: action chosen, waiting for object */
export class ActionBuilder {
    constructor(
        private readonly client: RuneClient,
        private readonly subject: string,
        private readonly action: Action,
    ) { }

    /** Step 3: which resource — triggers the API call */
    on(object: string, options?: { sct?: { lvn: number } }): Promise<Permission> {
        return this.client.check({
            subject: this.subject,
            action: this.action,
            object,
            ...(options?.sct && { sct: options.sct }),
        })
    }
}
