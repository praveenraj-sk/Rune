/**
 * rune index rebuild / rune index health CLI commands.
 *
 * Usage:
 *   rune index rebuild --url http://localhost:4078 --key rune_xxx [--samples 10]
 *   rune index health  --url http://localhost:4078 --key rune_xxx [--samples 20]
 */

type Tuple = { subject: string; relation: string; object: string }
type TuplesResponse = { tuples: Tuple[]; total: number; pages: number }

function parseOpts(args: string[]): Record<string, string> {
    const opts: Record<string, string> = {}
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]?.replace(/^--/, '')
        const val = args[i + 1]
        if (key && val) opts[key] = val
    }
    return opts
}

export async function indexRebuild(args: string[]): Promise<void> {
    const opts = parseOpts(args)
    const base = (opts['url'] ?? '').replace(/\/$/, '')
    const key = opts['key'] ?? ''
    const sampleCount = parseInt(opts['samples'] ?? '10', 10)

    if (!base || !key) {
        console.error('  ❌ Usage: rune index rebuild --url <url> --key <key>')
        process.exit(1)
    }

    const headers: Record<string, string> = { 'x-api-key': key, 'Content-Type': 'application/json' }

    console.log('🔄 Rune — Permission Index Rebuild\n')

    // Step 1: fetch all tuples (paginated)
    let page = 1, totalPages = 1
    const allTuples: Tuple[] = []
    console.log('📥 Fetching tuples...')
    do {
        const r = await fetch(`${base}/v1/tuples?page=${page}&limit=100`, { headers })
        if (!r.ok) { console.error(`❌ Failed to fetch tuples: HTTP ${r.status}`); process.exit(1) }
        const data = await r.json() as TuplesResponse
        allTuples.push(...data.tuples)
        totalPages = data.pages
        page++
    } while (page <= totalPages)

    console.log(`   → ${allTuples.length} tuple${allTuples.length === 1 ? '' : 's'} found`)

    if (allTuples.length === 0) {
        console.log('\n✅ No tuples — permission_index is trivially correct.')
        return
    }

    // Step 2: POST to rebuild endpoint
    console.log('\n🔧 Rebuilding index...')
    const r = await fetch(`${base}/v1/index/rebuild`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tuples: allTuples }),
    })
    if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
        console.error(`❌ Rebuild failed: ${err.error ?? r.statusText}`)
        process.exit(1)
    }
    const result = await r.json() as { indexed: number; cleared: boolean }
    console.log(`   → Cleared old index: ${result.cleared ? 'yes' : 'no'}`)
    console.log(`   → Indexed ${result.indexed} permission rows`)

    // Step 3: optional health check
    if (sampleCount > 0) {
        console.log(`\n🏥 Health check (${sampleCount} samples)...`)
        await indexHealth(['--url', base, '--key', key, '--samples', String(sampleCount)])
    } else {
        console.log('\n✅ Done.')
    }
}

export async function indexHealth(args: string[]): Promise<void> {
    const opts = parseOpts(args)
    const base = (opts['url'] ?? '').replace(/\/$/, '')
    const key = opts['key'] ?? ''
    const samples = opts['samples'] ?? '20'

    if (!base || !key) {
        console.error('  ❌ Usage: rune index health --url <url> --key <key>')
        process.exit(1)
    }

    const headers: Record<string, string> = { 'x-api-key': key }
    const r = await fetch(`${base}/v1/index/health?samples=${samples}`, { headers })
    if (!r.ok) { console.error('❌ Health check failed:', r.statusText); process.exit(1) }

    const data = await r.json() as {
        status: string; message: string; checked: number
        mismatches: number; mismatch_details: unknown[]; latency_ms: number
    }

    const icon = data.status === 'ok' ? '✅' : data.status === 'degraded' ? '⚠️' : '❌'
    console.log(`\n${icon} Index health: ${data.status.toUpperCase()}`)
    console.log(`   ${data.message}`)
    console.log(`   Checked: ${data.checked} · Mismatches: ${data.mismatches} · ${data.latency_ms}ms`)

    if (data.mismatch_details?.length) {
        console.log('\nStale entries:')
        console.table(data.mismatch_details)
        console.log('\nRun `rune index rebuild` to fix these.')
    }
    console.log()
}
