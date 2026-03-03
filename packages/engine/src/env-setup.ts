/**
 * env-setup.ts — MUST be the first import in server.ts
 *
 * Loads .env before any other module evaluates process.env.
 *
 * WHY a separate file:
 * In ESM, all `import` statements are hoisted and evaluated BEFORE any
 * top-level code runs. If we call loadEnv() inline in server.ts, it runs
 * AFTER config/index.ts is already imported and has read process.env.
 *
 * Importing this file as a side-effect (`import './env-setup.js'`) guarantees
 * dotenv runs first because ESM resolves modules in dependency order.
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

// process.cwd() = packages/engine/ when run via `pnpm dev`
// ../../.env = project root .env
// override: true — .env wins over any DATABASE_URL already in the shell
loadEnv({ path: resolve(process.cwd(), '../../.env'), override: true })
