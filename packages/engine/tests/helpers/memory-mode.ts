/**
 * Test helper: enable in-memory mode for zero-Postgres testing.
 *
 * Usage in a test file:
 *
 *   import { useMemoryMode } from '../helpers/memory-mode.js'
 *   useMemoryMode()   // call at top of describe() — sets up before/after hooks
 *
 * Or in vitest globalSetup:
 *
 *   import { enableMemoryMode } from '../../src/db/memory-adapter.js'
 *   enableMemoryMode()
 *
 * The memory store is reset before EACH test for isolation.
 */
import { beforeAll, afterAll, beforeEach } from 'vitest'
import { enableMemoryMode, disableMemoryMode, resetMemoryStore } from '../../src/db/memory-adapter.js'

/**
 * Call inside describe() to switch the entire test suite to memory mode.
 * Automatically resets data between tests.
 */
export function useMemoryMode(): void {
    beforeAll(() => {
        enableMemoryMode()
    })

    beforeEach(() => {
        resetMemoryStore()
    })

    afterAll(() => {
        disableMemoryMode()
    })
}

/**
 * Seed tuples directly into the memory store (shortcut for tests).
 */
export { getMemoryStore, resetMemoryStore } from '../../src/db/memory-adapter.js'
