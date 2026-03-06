/**
 * In-memory LVN (Logical Version Number) tracker.
 *
 * THE PROBLEM IT SOLVES:
 * The old code did `SELECT last_value FROM lvn_seq` on EVERY can() call,
 * including cache hits. A cache hit is supposed to be free (<1ms), but it
 * was silently making a full DB round-trip every single time.
 *
 * Example (before this fix):
 *   1000 req/min, 80% cache hit rate
 *   → 800 cache hits still doing a DB query → 800 pointless DB queries/min
 *
 * THE FIX:
 * Keep one number in memory. Writes update it. Reads use it instantly.
 * On server startup, sync once from DB to recover the correct value after restarts.
 *
 * HOW IT WORKS:
 *   - Server starts → refreshLvnFromDb() reads the real value from DB once
 *   - can() calls getLocalLvn() → returns the number instantly, zero DB cost
 *   - tuples.route.ts writes → calls updateLocalLvn(newLvn) → keeps it fresh
 */
import { query } from '../db/client.js'
import { logger } from '../logger/index.js'

/** The in-memory LVN value. Starts at 0, synced from DB on startup. */
let currentLvn = 0

/**
 * Get the current LVN — synchronous, zero DB cost.
 * Used by can() on every request (including cache hits).
 */
export function getLocalLvn(): number {
    return currentLvn
}

/**
 * Update the in-memory LVN after a successful write.
 * Called by tuples.route.ts after every POST/DELETE /tuples.
 *
 * Only updates if the new value is higher — protects against
 * out-of-order calls (shouldn't happen, but safe to guard).
 */
export function updateLocalLvn(lvn: number): void {
    if (lvn > currentLvn) {
        currentLvn = lvn
    }
}

/**
 * Sync LVN from DB — called ONCE on server startup.
 * Ensures the in-memory value is correct after a server restart.
 *
 * Never throws — LVN failure must not prevent the server from starting.
 * If DB is unreachable at startup, currentLvn stays 0 (safe — all
 * cache entries start with lvn=0 anyway after a fresh restart).
 */
export async function refreshLvnFromDb(): Promise<void> {
    try {
        const result = await query<{ last_value: string }>('SELECT last_value FROM lvn_seq')
        const dbLvn = parseInt(result.rows[0]?.last_value ?? '0', 10)
        currentLvn = dbLvn
        logger.info({ lvn: currentLvn }, 'lvn_synced_from_db_on_startup')
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'lvn_sync_failed_defaulting_to_zero')
    }
}
