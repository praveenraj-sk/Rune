#!/usr/bin/env node
/**
 * Rune CLI — authorization as code.
 *
 * Commands:
 *   rune init      — create rune.config.yml interactively
 *   rune validate  — validate your rune.config.yml
 *   rune explain   — trace a permission decision
 */
import { init } from './commands/init.js'
import { validate } from './commands/validate.js'
import { explain } from './commands/explain.js'
import { indexRebuild, indexHealth } from './commands/index-rebuild.js'

const args = process.argv.slice(2)
const command = args[0]

const HELP = `
  ╭─────────────────────────────────╮
  │  Rune — Authorization as Code   │
  ╰─────────────────────────────────╯

  Usage:
    rune init                              Create rune.config.yml
    rune validate                          Validate your config
    rune explain <subject> <action> <object>  Trace a decision
    rune index rebuild                     Rebuild permission_index from tuples
    rune index health                      Check index consistency vs BFS

  Examples:
    rune init
    rune validate
    rune explain user:arjun read document:readme
    rune index rebuild --url http://localhost:4078 --key rune_xxx
    rune index health  --url http://localhost:4078 --key rune_xxx

  More info: https://github.com/praveenraj-sk/Rune
`

async function main(): Promise<void> {
    switch (command) {
        case 'init':
            await init()
            break
        case 'validate':
            await validate()
            break
        case 'explain':
            await explain(args.slice(1))
            break
        case 'index': {
            const sub = args[1]
            if (sub === 'rebuild') await indexRebuild(args.slice(2))
            else if (sub === 'health') await indexHealth(args.slice(2))
            else { console.log('  Unknown index command. Use: rebuild | health'); process.exit(1) }
            break
        }
        case '--help':
        case '-h':
        case undefined:
            console.log(HELP)
            break
        default:
            console.log(`  Unknown command: ${command}\n`)
            console.log(HELP)
            process.exit(1)
    }
}

main().catch((err: Error) => {
    console.error(`\n  Error: ${err.message}\n`)
    process.exit(1)
})
