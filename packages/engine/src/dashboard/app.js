/**
 * Rune Admin Dashboard — app.js
 *
 * Auth flow:
 *   1. On load → check sessionStorage for saved admin key
 *   2. If found → verify against GET /v1/admin/verify (pure env-var hash check, no DB)
 *   3. If valid → load tenant list, show dashboard
 *   4. Sign out → clear sessionStorage, reload
 *
 * ALL data operations (logs, tuples, can) use /v1/admin/* endpoints which
 * accept the same admin key. No tenant API key is ever needed in the browser.
 */

const SESSION_KEY = 'rune_admin_key'

const app = {
    adminKey: '',
    tenantId: '',
    tenants: [],

    // ─── Boot ─────────────────────────────────────────────────────────
    async init() {
        const saved = sessionStorage.getItem(SESSION_KEY)
        if (saved) {
            const valid = await this.verifyKey(saved)
            if (valid) {
                this.adminKey = saved
                await this.showApp()
                return
            }
            sessionStorage.removeItem(SESSION_KEY)
        }
        this.showLogin()
    },

    // ─── Key verification (no DB, pure env-var hash check) ──────────
    async verifyKey(key) {
        try {
            const res = await fetch('/v1/admin/verify', { headers: { 'x-api-key': key } })
            return res.ok
        } catch {
            return false
        }
    },

    // ─── Login screen ─────────────────────────────────────────────────
    showLogin() {
        document.getElementById('login-screen').classList.remove('hidden')
        document.getElementById('app').classList.add('hidden')

        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault()
            const btn = document.getElementById('login-btn')
            const errEl = document.getElementById('login-error')
            const key = document.getElementById('login-key-input').value.trim()

            btn.disabled = true
            btn.textContent = 'Signing in…'
            errEl.classList.add('hidden')

            const valid = await this.verifyKey(key)

            if (valid) {
                sessionStorage.setItem(SESSION_KEY, key)
                this.adminKey = key
                await this.showApp()
            } else {
                errEl.classList.remove('hidden')
                btn.disabled = false
                btn.textContent = 'Sign In'
            }
        })
    },

    // ─── Main app ─────────────────────────────────────────────────────
    async showApp() {
        document.getElementById('login-screen').classList.add('hidden')
        document.getElementById('app').classList.remove('hidden')

        // Load tenant list
        await this.loadTenants()

        this.setupTabs()
        this.setupForms()
        this.setupSignOut()
        this.refreshLogs()
    },

    // ─── Tenant management ────────────────────────────────────────────
    async loadTenants() {
        try {
            const data = await this.api('/v1/admin/tenants')
            this.tenants = data.tenants || []
            if (this.tenants.length > 0) {
                this.tenantId = this.tenants[0].id
            }

            // If multiple tenants, render a picker in the sidebar
            if (this.tenants.length > 1) {
                const nav = document.querySelector('.sidebar-nav')
                const picker = document.createElement('div')
                picker.style.cssText = 'padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--border);'
                picker.innerHTML = `
                    <label style="font-size:0.75rem;font-weight:500;color:var(--text-muted);display:block;margin-bottom:0.3rem;text-transform:uppercase;letter-spacing:0.04em">Tenant</label>
                    <select id="tenant-picker" style="width:100%;font-size:0.8125rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:6px;background:#fff">
                        ${this.tenants.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                `
                nav.prepend(picker)
                picker.querySelector('#tenant-picker').addEventListener('change', (e) => {
                    this.tenantId = e.target.value
                    this.refreshLogs()
                })
            }
        } catch (err) {
            console.warn('Could not load tenants:', err.message)
        }
    },

    setupSignOut() {
        document.getElementById('signout-btn').addEventListener('click', () => {
            sessionStorage.removeItem(SESSION_KEY)
            location.reload()
        })
    },

    setupTabs() {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault()
                const tabId = e.currentTarget.dataset.tab
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
                e.currentTarget.classList.add('active')
                document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
                document.getElementById(`tab-${tabId}`).classList.remove('hidden')
                if (tabId === 'overview') this.refreshLogs()
            })
        })
    },

    setupForms() {
        document.getElementById('form-assign-access').addEventListener('submit', async (e) => {
            e.preventDefault()
            await this.changeTuple('POST', {
                subject: document.getElementById('assign-subject').value.trim(),
                relation: document.getElementById('assign-relation').value,
                object: document.getElementById('assign-object').value.trim(),
            }, 'assign-status')
        })

        document.getElementById('form-delete-access').addEventListener('submit', async (e) => {
            e.preventDefault()
            await this.changeTuple('DELETE', {
                subject: document.getElementById('delete-subject').value.trim(),
                relation: document.getElementById('delete-relation').value.trim(),
                object: document.getElementById('delete-object').value.trim(),
            }, 'delete-status')
        })

        document.getElementById('form-test-access').addEventListener('submit', async (e) => {
            e.preventDefault()
            await this.runTest(
                document.getElementById('test-subject').value.trim(),
                document.getElementById('test-action').value,
                document.getElementById('test-object').value.trim()
            )
        })
    },

    // ─── API helper — always uses admin key ──────────────────────────
    async api(path, options = {}) {
        const res = await fetch(path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.adminKey,
                ...options.headers,
            }
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`)
        return data
    },

    // ─── Activity Logs ────────────────────────────────────────────────
    async refreshLogs() {
        if (!this.tenantId) return
        const tbody = document.getElementById('logs-tbody')
        tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Loading…</td></tr>'

        try {
            const data = await this.api(`/v1/admin/logs?tenantId=${this.tenantId}`)
            const logs = data.logs || []

            if (!logs.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No recent activity for this tenant.</td></tr>'
                return
            }

            tbody.innerHTML = ''
            logs.forEach((log, i) => {
                const allow = log.status === 'ALLOW'
                const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

                const row = document.createElement('tr')
                row.innerHTML = `
                    <td><span class="badge ${allow ? 'badge-allow' : 'badge-deny'}">${log.status}</span></td>
                    <td style="font-weight:500">${log.subject}</td>
                    <td style="color:var(--text-muted)">${log.action}</td>
                    <td style="font-weight:500">${log.object}</td>
                    <td style="color:var(--text-muted);font-size:0.8125rem">${log.latency_ms != null ? parseFloat(log.latency_ms).toFixed(2) : '—'}ms</td>
                    <td style="color:var(--text-muted);font-size:0.8125rem">${time}</td>
                    <td><button class="expand-btn" onclick="app.toggleTrace(${i})">Trace ↓</button></td>
                `
                tbody.appendChild(row)

                const trace = (log.trace || []).map((t, idx) => {
                    const indent = '  '.repeat(idx)
                    const icon = allow && idx === log.trace.length - 1 ? '✅' : '├─'
                    return `${indent}${icon} ${t.node} (${t.result})`
                }).join('\n') || 'No trace data.'

                const traceRow = document.createElement('tr')
                traceRow.id = `trace-${i}`
                traceRow.className = 'trace-row hidden'
                traceRow.innerHTML = `
                    <td colspan="7" class="trace-cell">
                        <div class="trace-label">Reason</div>
                        <div class="trace-reason">${log.reason || '—'}</div>
                        <div class="trace-label">BFS Trace</div>
                        <div class="trace-tree">${trace}</div>
                    </td>
                `
                tbody.appendChild(traceRow)
            })
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-cell" style="color:var(--danger)">Error: ${err.message}</td></tr>`
        }
    },

    toggleTrace(i) { document.getElementById(`trace-${i}`)?.classList.toggle('hidden') },

    // ─── Directory ────────────────────────────────────────────────────
    async changeTuple(method, { subject, relation, object }, statusId) {
        const el = document.getElementById(statusId)
        el.className = 'status-msg'
        el.textContent = 'Processing…'
        el.classList.remove('hidden')

        try {
            await this.api('/v1/admin/tuples', {
                method,
                body: JSON.stringify({ tenantId: this.tenantId, subject, relation, object })
            })
            el.classList.add('status-success')
            el.textContent = `Relationship ${method === 'POST' ? 'added' : 'removed'} successfully.`
        } catch (err) {
            el.classList.add('status-error')
            el.textContent = `Error: ${err.message}`
        }
    },

    // ─── Playground ───────────────────────────────────────────────────
    async runTest(subject, action, object) {
        const container = document.getElementById('test-result-container')
        const btn = document.getElementById('test-btn')
        btn.disabled = true
        btn.textContent = 'Running…'
        container.innerHTML = '<div class="result-empty"><p>Running BFS traversal…</p></div>'

        try {
            const data = await this.api('/v1/admin/can', {
                method: 'POST',
                body: JSON.stringify({ tenantId: this.tenantId, subject, action, object })
            })

            const allow = data.status === 'ALLOW'
            const trace = (data.trace || []).map((t, i) => {
                const indent = '  '.repeat(i)
                const icon = allow && i === data.trace.length - 1 ? '✅' : '├─'
                return `${indent}${icon} ${t.node} (${t.result})`
            }).join('\n') || 'No trace points.'

            container.innerHTML = `
                <div>
                    <div class="result-status ${allow ? 'result-allow' : 'result-deny'}">${data.status}</div>
                    <div style="font-size:0.8125rem;color:var(--text-muted)">${data.latency_ms?.toFixed(2)}ms · cache ${data.cache_hit ? 'HIT' : 'MISS'}</div>
                    <hr class="result-divider">
                    <div class="result-label">Reason</div>
                    <div style="font-size:0.875rem;color:var(--text-muted);margin-bottom:1rem">${data.reason}</div>
                    <div class="result-label">BFS Trace</div>
                    <pre class="result-trace">${trace}</pre>
                </div>
            `
        } catch (err) {
            container.innerHTML = `
                <div style="padding:1rem;background:var(--error-bg);border-radius:var(--radius);color:var(--error-text);font-size:0.875rem">
                    <strong>Request failed</strong><br>${err.message}
                </div>
            `
        } finally {
            btn.disabled = false
            btn.textContent = 'Run Test'
        }
    }
}

document.addEventListener('DOMContentLoaded', () => app.init())
