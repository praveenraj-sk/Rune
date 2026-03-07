import type { RuneConfig } from '../src/index.js'

export const testConfig: RuneConfig = {
    version: 1,
    resources: {
        doc: {
            mode: 'rebac',
            roles: {
                owner: { actions: ['read', 'edit', 'delete', 'manage'] },
                viewer: { actions: ['read'] },
            },
        },
        zone: {
            mode: 'rebac',
            roles: {
                member: { actions: ['read'] },
            },
        },
    },
}
