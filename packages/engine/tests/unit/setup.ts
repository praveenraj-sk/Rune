import { vi } from 'vitest'

export function setupMocks() {
    vi.mock('../../src/db/client.js', () => ({
        query: vi.fn(),
        getClient: vi.fn(),
        pool: { on: vi.fn() },
    }))

    vi.mock('../../src/logger/index.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))

    vi.mock('../../src/policy/config.js', () => ({
        loadPolicy: vi.fn(),
        getPolicy: vi.fn(() => ({
            resources: {
                doc: {
                    mode: 'rebac',
                    roles: { viewer: { actions: ['read'] } },
                },
            },
        })),
        getValidRelations: vi.fn(() => ['viewer']),
        extractResourceType: vi.fn((obj: string) => obj.split(':')[0] ?? 'unknown'),
    }))

    vi.mock('../../src/cache/lru.js', () => ({
        cache: {
            buildKey: vi.fn((_t: string, s: string, o: string, a: string) => `${s}:${o}:${a}`),
            isStale: vi.fn(() => false),
            get: vi.fn(() => undefined),
            set: vi.fn(),
            deleteByTenant: vi.fn(),
            deleteByChanged: vi.fn(),
        },
    }))

    vi.mock('../../src/engine/lvn.js', () => ({
        getLocalLvn: vi.fn(() => 42),
        updateLocalLvn: vi.fn(),
        refreshLvnFromDb: vi.fn(),
    }))

    vi.mock('../../src/db/permission-index.js', () => ({
        checkIndex: vi.fn(() => false),
        indexGrant: vi.fn(),
        removeGrant: vi.fn(),
        clearTenantIndex: vi.fn(),
    }))
}
