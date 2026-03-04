/* ── Rune Dashboard — Enterprise JavaScript ── */

let API_KEY = '', BASE_URL = '', currentPage = 1, currentSearch = '', currentLogFilter = 'all', allLogs = [], searchTimeout = null;

function getBaseUrl() { return window.location.origin }

/* ── Auth ── */
async function authenticate() {
    const key = document.getElementById('authKey').value.trim();
    if (!key) { document.getElementById('authError').textContent = 'Please enter your API key'; return }
    BASE_URL = getBaseUrl();
    try {
        const r = await fetch(BASE_URL + '/v1/health');
        if (!r.ok) throw new Error('Engine unreachable');
        const s = await fetch(BASE_URL + '/v1/stats', { headers: { 'x-api-key': key } });
        if (s.status === 401) { document.getElementById('authError').textContent = 'Invalid API key'; return }
        if (!s.ok) throw new Error('Connection failed');
        API_KEY = key; localStorage.setItem('rune_key', key);
        document.getElementById('authScreen').style.display = 'none';
        document.getElementById('layout').style.display = 'flex';
        loadAll();
    } catch (e) { document.getElementById('authError').textContent = e.message }
}

function logout() {
    API_KEY = ''; localStorage.removeItem('rune_key');
    document.getElementById('layout').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('authKey').value = '';
    document.getElementById('authError').textContent = '';
}

window.addEventListener('DOMContentLoaded', () => {
    const k = localStorage.getItem('rune_key');
    if (k) { document.getElementById('authKey').value = k; authenticate() }
});
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authKey').addEventListener('keydown', e => { if (e.key === 'Enter') authenticate() });
});

/* ── API ── */
async function api(m, p, b) {
    const o = { method: m, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' } };
    if (b) o.body = JSON.stringify(b);
    const r = await fetch(BASE_URL + p, o);
    if (r.status === 401) { logout(); throw new Error('Unauthorized') }
    return r.json();
}

async function loadAll() { await Promise.all([loadStats(), loadTuples(), loadLogs(), loadSettings()]) }

/* ── Stats ── */
async function loadStats() {
    try {
        const d = await api('GET', '/v1/stats');
        document.getElementById('statTuples').textContent = d.total_tuples.toLocaleString();
        document.getElementById('statDecisions').textContent = d.decisions_today.toLocaleString();
        document.getElementById('statDecisionsSub').textContent = d.allow_today + ' allowed, ' + d.deny_today + ' denied';
        document.getElementById('statLatency').textContent = d.avg_latency_ms.toFixed(1);
        const rate = d.decisions_today > 0 ? Math.round(d.allow_today / d.decisions_today * 1000) / 10 : 0;
        document.getElementById('statAllowRate').textContent = rate + '%';
        document.getElementById('statCacheSub').textContent = 'Cache: ' + d.cache_stats.size + ' / ' + d.cache_stats.maxSize;
    } catch (e) { }
}

/* ── Recent Logs ── */
async function loadRecentLogs() {
    try {
        const d = await api('GET', '/v1/logs');
        const t = document.getElementById('recentLogs');
        if (!d.logs.length) { t.innerHTML = '<tr><td colspan="6" class="empty"><p>No decisions yet</p></td></tr>'; return }
        t.innerHTML = d.logs.slice(0, 8).map(l =>
            '<tr><td class="mono">' + esc(l.subject) +
            '</td><td class="mono">' + esc(l.action) +
            '</td><td class="mono">' + esc(l.object) +
            '</td><td><span class="pill pill-' + (l.status === 'ALLOW' ? 'allow' : l.status === 'NOT_FOUND' ? 'notfound' : 'deny') + '">' + esc(l.status) +
            '</span></td><td class="text-muted">' + parseFloat(l.latency_ms).toFixed(1) + 'ms' +
            '</td><td class="text-muted">' + timeAgo(l.created_at) + '</td></tr>'
        ).join('');
    } catch (e) { }
}

/* ── Tuples ── */
async function loadTuples(page, search) {
    page = page || 1; search = search || ''; currentPage = page; currentSearch = search;
    try {
        const p = new URLSearchParams({ page: String(page), limit: '20' });
        if (search) p.set('search', search);
        const d = await api('GET', '/v1/tuples?' + p);
        const t = document.getElementById('tuplesBody');
        if (!d.tuples.length) {
            t.innerHTML = '<tr><td colspan="5" class="empty"><p>No relationships found</p></td></tr>';
        } else {
            t.innerHTML = d.tuples.map(r =>
                '<tr><td class="mono">' + esc(r.subject) +
                '</td><td><span class="pill pill-relation">' + esc(r.relation) +
                '</span></td><td class="mono">' + esc(r.object) +
                '</td><td class="text-muted">' + timeAgo(r.created_at) +
                '</td><td><button class="btn btn-remove btn-sm" onclick="removeTuple(\'' + esc(r.subject) + '\',\'' + esc(r.relation) + '\',\'' + esc(r.object) + '\')">Remove</button></td></tr>'
            ).join('');
        }
        const pg = document.getElementById('pagination');
        if (d.pages > 1) {
            pg.innerHTML = '<button class="page-btn" onclick="loadTuples(' + (page - 1) + ',\'' + esc(search) + '\')" ' + (page <= 1 ? 'disabled' : '') + '>Prev</button>' +
                '<span class="page-info">Page ' + page + ' of ' + d.pages + ' (' + d.total + ' total)</span>' +
                '<button class="page-btn" onclick="loadTuples(' + (page + 1) + ',\'' + esc(search) + '\')" ' + (page >= d.pages ? 'disabled' : '') + '>Next</button>';
        } else {
            pg.innerHTML = d.total > 0 ? '<span class="page-info">' + d.total + ' relationship' + (d.total === 1 ? '' : 's') + '</span>' : '';
        }
    } catch (e) { }
}

function debouncedSearch() { clearTimeout(searchTimeout); searchTimeout = setTimeout(() => loadTuples(1, document.getElementById('tupleSearch').value), 300) }
function showAddModal() { document.getElementById('addModal').classList.add('show') }
function hideAddModal() { document.getElementById('addModal').classList.remove('show');['addSubject', 'addRelation', 'addObject'].forEach(i => document.getElementById(i).value = '') }

async function addTuple() {
    const s = document.getElementById('addSubject').value.trim(),
        r = document.getElementById('addRelation').value.trim(),
        o = document.getElementById('addObject').value.trim();
    if (!s || !r || !o) return;
    try {
        await api('POST', '/v1/tuples', { subject: s, relation: r, object: o });
        hideAddModal();
        loadTuples(currentPage, currentSearch);
        loadStats();
    } catch (e) { alert('Failed: ' + e.message) }
}

async function removeTuple(s, r, o) {
    if (!confirm('Remove: ' + s + ' → ' + r + ' → ' + o + '?')) return;
    try {
        await api('DELETE', '/v1/tuples', { subject: s, relation: r, object: o });
        loadTuples(currentPage, currentSearch);
        loadStats();
    } catch (e) { alert('Failed: ' + e.message) }
}

/* ── Logs ── */
async function loadLogs() {
    try { const d = await api('GET', '/v1/logs'); allLogs = d.logs; renderLogs(); loadRecentLogs() } catch (e) { }
}

function renderLogs() {
    const f = currentLogFilter === 'all' ? allLogs : allLogs.filter(l => currentLogFilter === 'allow' ? l.status === 'ALLOW' : l.status !== 'ALLOW');
    const t = document.getElementById('logsBody');
    if (!f.length) { t.innerHTML = '<tr><td colspan="8" class="empty"><p>No matching logs</p></td></tr>'; return }
    t.innerHTML = f.map(l =>
        '<tr><td class="mono">' + esc(l.subject) +
        '</td><td class="mono">' + esc(l.action) +
        '</td><td class="mono">' + esc(l.object) +
        '</td><td><span class="pill pill-' + (l.status === 'ALLOW' ? 'allow' : l.status === 'NOT_FOUND' ? 'notfound' : 'deny') + '">' + esc(l.status) +
        '</span></td><td class="text-muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.reason || '—') +
        '</td><td class="text-muted">' + parseFloat(l.latency_ms).toFixed(1) + 'ms' +
        '</td><td class="text-muted">' + (l.cache_hit ? 'Cache' : 'Live') +
        '</td><td class="text-muted">' + timeAgo(l.created_at) + '</td></tr>'
    ).join('');
}

function filterLogs(type, el) {
    currentLogFilter = type;
    document.querySelectorAll('.filters .btn-ghost').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    renderLogs();
}

/* ── Permission Debugger ── */
async function runDebugger() {
    const subject = document.getElementById('dbgSubject').value.trim();
    const action = document.getElementById('dbgAction').value.trim();
    const object = document.getElementById('dbgObject').value.trim();
    const tenant = document.getElementById('dbgTenant').value.trim() || 'default';

    if (!subject || !action || !object) {
        alert('Please fill in Subject, Action, and Object');
        return;
    }

    const btn = document.getElementById('dbgRunBtn');
    const resultDiv = document.getElementById('debuggerResult');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
        const result = await api('POST', '/v1/can', { subject, action, object, tenant });

        const isAllow = result.status === 'ALLOW';
        resultDiv.className = 'debugger-result ' + (isAllow ? 'result-allow' : 'result-deny');

        let html = '<div class="result-header">';
        html += '<span class="result-badge ' + (isAllow ? 'badge-allow' : 'badge-deny') + '">';
        html += (isAllow ? '✓' : '✗') + ' ' + result.status;
        html += '</span>';
        html += '<span class="result-latency">' + parseFloat(result.latency_ms).toFixed(2) + 'ms</span>';
        html += '</div>';

        // ReBAC trace
        html += '<div class="trace-section">';
        html += '<div class="trace-title">ReBAC — Graph Traversal</div>';
        if (result.trace && result.trace.length > 0) {
            html += '<div class="trace-item"><span class="trace-check trace-pass">✓</span>';
            html += '<span>Path: <code>' + esc(result.trace.join(' → ')) + '</code></span></div>';
        } else if (result.status === 'NOT_FOUND') {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>Object not found in store</span></div>';
        } else {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>No path found from subject to object</span></div>';
        }
        html += '</div>';

        // RBAC
        html += '<div class="trace-section">';
        html += '<div class="trace-title">RBAC — Role Resolution</div>';
        if (result.trace && result.trace.length > 0) {
            html += '<div class="trace-item"><span class="trace-check trace-pass">✓</span>';
            html += '<span>Role grants <code>' + esc(action) + '</code></span></div>';
        } else {
            html += '<div class="trace-item"><span class="trace-check trace-fail">✗</span>';
            html += '<span>No role grants <code>' + esc(action) + '</code></span></div>';
        }
        html += '</div>';

        // ABAC conditions
        if (result.condition_results && result.condition_results.length > 0) {
            html += '<div class="trace-section">';
            html += '<div class="trace-title">ABAC — Conditions</div>';
            for (const c of result.condition_results) {
                html += '<div class="trace-item">';
                html += '<span class="trace-check ' + (c.passed ? 'trace-pass' : 'trace-fail') + '">' + (c.passed ? '✓' : '✗') + '</span>';
                html += '<span><code>' + esc(c.name) + '</code>: ' + esc(c.reason) + '</span>';
                html += '</div>';
            }
            html += '</div>';
        }

        // Reason
        html += '<div class="trace-section">';
        html += '<div class="trace-title">Reason</div>';
        html += '<div class="trace-item" style="font-family:var(--font-mono);font-size:0.8rem;color:var(--gray-600)">';
        html += esc(result.reason || '—');
        html += '</div></div>';

        // Suggested fix
        if (result.suggested_fix && result.suggested_fix.length > 0) {
            html += '<div class="trace-section">';
            html += '<div class="trace-title">Suggested Fix</div>';
            for (const fix of result.suggested_fix) {
                html += '<div class="trace-item" style="font-family:var(--font-mono);font-size:0.78rem">';
                html += esc(fix);
                html += '</div>';
            }
            html += '</div>';
        }

        resultDiv.innerHTML = html;
    } catch (e) {
        resultDiv.className = 'debugger-result result-deny';
        resultDiv.innerHTML = '<div class="result-header"><span class="result-badge badge-deny">✗ ERROR</span></div>' +
            '<div class="trace-item"><span>' + esc(e.message) + '</span></div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Check Permission';
    }
}

/* ── Settings ── */
async function loadSettings() {
    document.getElementById('settingsUrl').textContent = BASE_URL;
    document.getElementById('settingsKey').textContent = API_KEY.slice(0, 8) + '••••••••' + API_KEY.slice(-4);
    try {
        const h = await fetch(BASE_URL + '/v1/health').then(r => r.json());
        document.getElementById('settingsStatus').textContent = h.status === 'ok' ? 'Connected' : 'Degraded';
        document.getElementById('settingsDb').textContent = h.db === 'connected' ? 'Connected' : 'Error';
        const s = await api('GET', '/v1/stats');
        document.getElementById('settingsCacheMax').textContent = s.cache_stats.maxSize.toLocaleString();
        document.getElementById('settingsCacheCurrent').textContent = s.cache_stats.size.toLocaleString();
    } catch (e) { }
}

/* ── Navigation ── */
function switchTab(name) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
    if (name === 'overview') { loadStats(); loadRecentLogs() }
    if (name === 'relationships') loadTuples(currentPage, currentSearch);
    if (name === 'logs') loadLogs();
    if (name === 'settings') loadSettings();
}

/* ── Helpers ── */
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML }
function timeAgo(d) { const s = (Date.now() - new Date(d).getTime()) / 1000; if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago' }

/* ── Auto Refresh ── */
setInterval(() => { if (API_KEY && document.getElementById('panel-overview').classList.contains('active')) { loadStats(); loadRecentLogs() } }, 10000);
