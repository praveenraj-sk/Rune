/**
 * rune init — create rune.config.yml interactively
 */
import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, resolve))
}

export async function init(): Promise<void> {
    const configPath = join(process.cwd(), 'rune.config.yml')

    if (existsSync(configPath)) {
        const overwrite = await ask('  rune.config.yml already exists. Overwrite? (y/N) ')
        if (overwrite.toLowerCase() !== 'y') {
            console.log('  Aborted.\n')
            rl.close()
            return
        }
    }

    console.log('\n  ╭─────────────────────────────────╮')
    console.log('  │  Rune — Create Authorization    │')
    console.log('  ╰─────────────────────────────────╯\n')

    // Collect resources
    const resources: Array<{ name: string; roles: Array<{ name: string; actions: string[]; inherits: string[] }> }> = []

    let addMore = true
    while (addMore) {
        const resourceName = await ask('  Resource name (e.g. document, project): ')
        if (!resourceName.trim()) break

        const roles: Array<{ name: string; actions: string[]; inherits: string[] }> = []
        let addMoreRoles = true

        while (addMoreRoles) {
            const roleName = await ask(`    Role name for ${resourceName} (e.g. admin, editor, viewer): `)
            if (!roleName.trim()) break

            const actionsStr = await ask(`    Actions for ${roleName} (comma-separated, e.g. read,edit,delete): `)
            const actions = actionsStr.split(',').map(a => a.trim()).filter(Boolean)

            const inheritsStr = await ask(`    Inherits from (comma-separated, or empty): `)
            const inherits = inheritsStr.split(',').map(a => a.trim()).filter(Boolean)

            roles.push({ name: roleName.trim(), actions, inherits })

            const more = await ask('    Add another role? (y/N) ')
            addMoreRoles = more.toLowerCase() === 'y'
        }

        resources.push({ name: resourceName.trim(), roles })

        const moreRes = await ask('\n  Add another resource? (y/N) ')
        addMore = moreRes.toLowerCase() === 'y'
    }

    // Generate YAML
    let yaml = '# Rune Authorization Config\n'
    yaml += '# Docs: https://github.com/praveenraj-sk/Rune\n\n'
    yaml += 'version: 1\n\n'
    yaml += 'resources:\n'

    for (const res of resources) {
        yaml += `  ${res.name}:\n`
        yaml += '    roles:\n'
        for (const role of res.roles) {
            if (role.inherits.length > 0) {
                yaml += `      ${role.name}:\n`
                yaml += `        inherits: [${role.inherits.join(', ')}]\n`
                yaml += `        actions: [${role.actions.join(', ')}]\n`
            } else {
                yaml += `      ${role.name}:\n`
                yaml += `        actions: [${role.actions.join(', ')}]\n`
            }
        }
    }

    writeFileSync(configPath, yaml, 'utf-8')
    console.log(`\n  ✓ Created ${configPath}\n`)
    console.log('  Next steps:')
    console.log('    1. Review your rune.config.yml')
    console.log('    2. Run: rune validate')
    console.log('    3. Add to your app: rune.protect(\'read\', \'document:{{params.id}}\')\n')

    rl.close()
}
