/**
 * Global test setup for all engine tests.
 * Runs before each test file.
 */
import { config } from 'dotenv'

// Load .env for tests — override:true ensures .env wins over any DATABASE_URL
// already set in the shell environment (e.g. system Postgres on macOS/Linux)
config({ path: '../../.env', override: true })

// Verify required env vars are present before any test runs
if (!process.env['DATABASE_URL']) {
    throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and configure it.\n' +
        'Run: cp ../../.env.example ../../.env'
    )
}
