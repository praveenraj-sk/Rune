/**
 * Strict integration test against live Render deployment.
 * Tests all Priority 1-5 features end-to-end.
 */

const API = 'https://rune-engine.onrender.com'
const KEY = 'rune_6Cbe8S9BxAIB5injK6FCiBYLwFiq3yGC'
const SETUP_SECRET = 'faaff69feda3c69750bead9abd10b97a445191a3ebaed4563d3e2a271a73fb92'

let passed = 0
let failed = 0

function assert(condition, msg) {
    if (condition) {
        console.log(`  ✅ ${msg}`)
        passed++
    } else {
        console.log(`  ❌ FAIL: ${msg}`)
        failed++
    }
}

async function api(method, path, body, headers = {}) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, ...headers },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${API}${path}`, opts)
    const data = await res.json()
    return { status: res.status, data }
}

async function run() {
    console.log('\n🔬 STRICT INTEGRATION TESTS\n')

    // ─── 1. Health ───────────────────────────────────
    console.log('── Health ──')
    const health = await api('GET', '/v1/health', null, {})
    assert(health.status === 200, `Health returns 200 (got ${health.status})`)
    assert(health.data.status === 'ok', `Health status is "ok" (got "${health.data.status}")`)
    assert(health.data.db === 'connected', `DB is connected (got "${health.data.db}")`)

    // ─── 2. Migration ────────────────────────────────
    console.log('\n── Migration ──')
    const migrate = await api('POST', '/v1/migrate', {}, {
        'Authorization': `Bearer ${SETUP_SECRET}`,
        'x-api-key': undefined,
    })
    assert(migrate.status === 200, `Migration returns 200 (got ${migrate.status})`)
    assert(migrate.data.message?.includes('Migrations complete'), `Migration message OK`)

    // ─── 3. Standard Relations (viewer/editor/owner) ─
    console.log('\n── Standard Relations ──')
    const r1 = await api('POST', '/v1/tuples', {
        subject: 'user:testbot',
        relation: 'viewer',
        object: 'doc:test-strict-001',
    })
    assert(r1.status === 200, `Add viewer relation returns 200 (got ${r1.status})`)
    assert(r1.data.success === true, `Add viewer success=true`)

    const c1 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'read',
        object: 'doc:test-strict-001',
    })
    assert(c1.status === 200, `Check read returns 200 (got ${c1.status})`)
    assert(c1.data.status === 'ALLOW', `viewer can read → ALLOW (got "${c1.data.status}")`)

    const c2 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'edit',
        object: 'doc:test-strict-001',
    })
    assert(c2.data.status === 'DENY', `viewer cannot edit → DENY (got "${c2.data.status}")`)

    const c3 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'delete',
        object: 'doc:test-strict-001',
    })
    assert(c3.data.status === 'DENY', `viewer cannot delete → DENY (got "${c3.data.status}")`)

    // ─── 4. Custom Relations (Priority 2) ────────────
    console.log('\n── Custom Relations (Priority 2) ──')
    const r2 = await api('POST', '/v1/tuples', {
        subject: 'user:testbot',
        relation: 'approve',
        object: 'invoice:INV-STRICT-001',
    })
    assert(r2.status === 200, `Add custom relation "approve" returns 200 (got ${r2.status})`)
    assert(r2.data.success === true, `Add approve relation success=true`)

    // ─── 5. Custom Actions (Priority 1) ──────────────
    console.log('\n── Custom Actions (Priority 1) ──')
    const c4 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'approve',
        object: 'invoice:INV-STRICT-001',
    })
    assert(c4.status === 200, `Check custom action "approve" returns 200 (got ${c4.status})`)
    assert(c4.data.status === 'ALLOW', `approve relation can approve → ALLOW (got "${c4.data.status}")`)

    // Custom action the user does NOT have
    const c5 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'export',
        object: 'invoice:INV-STRICT-001',
    })
    assert(c5.data.status === 'DENY', `non-exporter cannot export → DENY (got "${c5.data.status}")`)

    // Owner can do anything (including custom actions)
    const r3 = await api('POST', '/v1/tuples', {
        subject: 'user:boss',
        relation: 'owner',
        object: 'invoice:INV-STRICT-001',
    })
    assert(r3.status === 200, `Add owner relation returns 200`)

    const c6 = await api('POST', '/v1/can', {
        subject: 'user:boss',
        action: 'approve',
        object: 'invoice:INV-STRICT-001',
    })
    assert(c6.data.status === 'ALLOW', `owner can approve (custom action) → ALLOW (got "${c6.data.status}")`)

    const c7 = await api('POST', '/v1/can', {
        subject: 'user:boss',
        action: 'export',
        object: 'invoice:INV-STRICT-001',
    })
    assert(c7.data.status === 'ALLOW', `owner can export (custom action) → ALLOW (got "${c7.data.status}")`)

    // ─── 6. NOT_FOUND ────────────────────────────────
    console.log('\n── NOT_FOUND ──')
    const c8 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'read',
        object: 'doc:nonexistent-xyz-999',
    })
    assert(c8.data.status === 'NOT_FOUND', `Non-existent object → NOT_FOUND (got "${c8.data.status}")`)

    // ─── 7. Revoke & Re-check ────────────────────────
    console.log('\n── Revoke & Re-check ──')
    const rev = await api('DELETE', '/v1/tuples', {
        subject: 'user:testbot',
        relation: 'approve',
        object: 'invoice:INV-STRICT-001',
    })
    assert(rev.status === 200, `Revoke approve returns 200 (got ${rev.status})`)

    const c9 = await api('POST', '/v1/can', {
        subject: 'user:testbot',
        action: 'approve',
        object: 'invoice:INV-STRICT-001',
    })
    assert(c9.data.status === 'DENY', `After revoke, approve → DENY (got "${c9.data.status}")`)

    // ─── 8. Decision Logs ────────────────────────────
    console.log('\n── Decision Logs ──')
    const logs = await api('GET', '/v1/logs')
    assert(logs.status === 200, `Logs endpoint returns 200 (got ${logs.status})`)
    assert(Array.isArray(logs.data.logs), `Logs contains array`)
    assert(logs.data.logs.length > 0, `Logs has entries (got ${logs.data.logs.length})`)

    // ─── 9. Auth Errors ──────────────────────────────
    console.log('\n── Auth Errors ──')
    const nokey = await fetch(`${API}/v1/can`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'user:x', action: 'read', object: 'doc:y' }),
    })
    assert(nokey.status === 401, `Missing API key → 401 (got ${nokey.status})`)

    const badkey = await fetch(`${API}/v1/can`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'rune_INVALID' },
        body: JSON.stringify({ subject: 'user:x', action: 'read', object: 'doc:y' }),
    })
    assert(badkey.status === 401, `Bad API key → 401 (got ${badkey.status})`)

    // ─── 10. Explainability ──────────────────────────
    console.log('\n── Explainability (reason, trace, suggested_fix) ──')
    assert(typeof c1.data.reason === 'string' && c1.data.reason.length > 0, `ALLOW has reason string`)
    assert(Array.isArray(c1.data.trace), `ALLOW has trace array`)
    assert(typeof c1.data.latency_ms === 'number', `ALLOW has latency_ms`)
    assert(typeof c1.data.sct === 'object', `ALLOW has sct object`)

    const deny_data = c2.data
    assert(typeof deny_data.reason === 'string' && deny_data.reason.length > 0, `DENY has reason string`)
    assert(Array.isArray(deny_data.suggested_fix), `DENY has suggested_fix array`)

    // ─── 11. Cleanup ─────────────────────────────────
    console.log('\n── Cleanup ──')
    await api('DELETE', '/v1/tuples', { subject: 'user:testbot', relation: 'viewer', object: 'doc:test-strict-001' })
    await api('DELETE', '/v1/tuples', { subject: 'user:boss', relation: 'owner', object: 'invoice:INV-STRICT-001' })
    console.log('  🧹 Test data cleaned up')

    // ─── Summary ─────────────────────────────────────
    console.log(`\n${'═'.repeat(50)}`)
    console.log(`   RESULTS: ${passed} passed, ${failed} failed`)
    console.log(`${'═'.repeat(50)}\n`)

    if (failed > 0) process.exit(1)
}

run().catch(err => {
    console.error('💥 Test runner crashed:', err.message)
    process.exit(1)
})
