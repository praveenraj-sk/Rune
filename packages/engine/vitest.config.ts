import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // Run tests sequentially — DB tests must not run in parallel
        // to avoid transaction conflicts
        pool: 'forks',
        poolOptions: {
            forks: { singleFork: true }
        },
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.test.ts'],
        testTimeout: 15000,  // DB tests can be slow on cold start
    },
})
