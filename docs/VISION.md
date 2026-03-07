# Why Rune? — How We Solve Every Authorization Pain Point

Authorization is broken. Every tool on the market — Permit.io, Auth0 FGA, SpiceDB, OpenFGA — forces developers to choose between flexibility, simplicity, and cost. Rune doesn't.

---

## The 9 Problems (and How Rune Fixes Each One)

---

### 1. "Integration takes 3+ weeks"

**The industry problem:** Most authorization tools require you to understand Zanzibar concepts, set up infrastructure, model your permissions, write sync code, and integrate into every route. That's weeks of work before you see any value.

**How Rune solves it:**

```bash
# Step 1: Scaffold (5 minutes)
npx create-rune my-app
# → Generates config, Docker Compose, middleware, env file

# Step 2: Define your model (30 minutes)
# rune.config.yml — human-readable, no code
resources:
  document:
    roles:
      viewer: [read]
      editor: [read, edit, share]
      owner: [read, edit, delete, share]

# Step 3: Protect routes (1 line per route)
app.get('/documents/:id',
  rune.protect({ action: 'read', object: 'doc:{{params.id}}' }),
  handler
)
```

**Result:** 1 day, not 3 weeks. The CLI guides you through modeling, generates boilerplate, and drops into your existing Express/Fastify app with one-line middleware.

**What exists today:** SDK with fluent API (`rune.can('user:arjun').do('read').on('doc:1')`), npm install, 3 lines to start. CLI scaffolder and middleware helpers are on the roadmap.

---

### 2. "No UI for non-devs — engineers are middlemen"

**The industry problem:** Most authorization systems are API-only. When a PM asks "give Arjun access to Project X," an engineer has to open a terminal, write a curl command or code, and run it. Every permission change needs a developer.

**How Rune solves it:**

Rune ships with an **Admin Dashboard** — a web UI embedded in the engine.

```
┌──────────────────────────────────────────────────────┐
│  🔐 Rune Admin                                      │
│                                                      │
│  Relationships                     🔍 Filter...      │
│  ┌────────────────────────────────────────────────┐  │
│  │ user:arjun    │ editor   │ project:x  │ 🗑️    │  │
│  │ user:priya    │ viewer   │ project:x  │ 🗑️    │  │
│  └────────────────────────────────────────────────┘  │
│  [+ Add Relationship]                                │
│                                                      │
│  Recent Decisions                                    │
│  ✅ user:arjun → read → project:x    (3ms)          │
│  ❌ user:stranger → edit → project:x (2ms)          │
└──────────────────────────────────────────────────────┘
```

A PM clicks **"Add Relationship"**, picks a user, role, and resource from dropdowns — done. No terminal, no code, no engineer needed.

**What exists today:** Full admin dashboard at `/admin` — login, activity log viewer, relationship directory, and a live permission playground. Backed by a full API (`POST /v1/tuples`, `DELETE /v1/tuples`, `GET /v1/logs`, `POST /admin/can`, etc.).

---

### 3. "Data sync nightmares between app DB and AuthZ store"

**The industry problem:** Every authorization tool (Permit.io, SpiceDB, Auth0 FGA) requires you to **duplicate** your data into their store. Your `users` table is in YOUR database. Their `tuples` table is in THEIR database. You must write sync code to keep them consistent. When a user is deleted from your app but not from the auth store — ghost permissions. When a user is added but sync fails — silently denied.

**How Rune solves it: Zero-Sync**

Rune reads **your existing database tables directly**. No duplication. No sync code.

```yaml
# rune.config.yml
sync:
  mode: zero-sync
  connection: ${DATABASE_URL}     # YOUR database

  mappings:
    - table: team_members           # YOUR table
      subject: "user:{{user_id}}"
      relation: "member"
      object: "team:{{team_id}}"

    - table: document_shares        # YOUR table
      subject: "user:{{user_id}}"
      relation: "{{permission}}"    # reads 'viewer'/'editor' from your column
      object: "doc:{{document_id}}"
```

When Rune checks `can user:1 do read on doc:5?`, it generates:

```sql
-- Queries YOUR tables, not a separate tuple store
SELECT user_id, permission, document_id
FROM   document_shares
WHERE  user_id = 1 AND document_id = 5
```

**Your database is the single source of truth. No sync. No ghosts. No nightmares.**

**What exists today:** Zero-Sync is fully implemented. Add a `datasources` block to `rune.config.yml`, point it at your existing tables, and Rune's BFS traversal reads from both sources transparently — no data duplication, no sync code.

---

### 4. "Unpredictable pricing at scale"

**The industry problem:** Permit.io charges per-check. Auth0 FGA charges per-check. At 10M checks/month you're looking at $1000+/month with "contact sales" pricing that nobody can predict.

**How Rune solves it: Self-hosted. You own the infra.**

| Scale | Permit.io | Rune |
|---|---|---|
| 1K checks/month | Free | Free (Render free tier) |
| 100K checks/month | ~$100/mo | ~$7/mo (Render starter) |
| 10M checks/month | ~$1,000+/mo | ~$25/mo (any VPS) |
| Unlimited | "Contact sales" | Same $25/mo |

No per-check pricing. No usage tiers. No surprises. Deploy on your own infra (Render, Railway, AWS, bare metal) and pay only for compute + database.

**What exists today:** Fully solved. Rune is self-hosted on Render. Production deployed at `https://rune-engine.onrender.com`.

---

### 5. "No unified RBAC + ReBAC + ABAC in one tool"

**The industry problem:** Most tools support one model. SpiceDB/OpenFGA = ReBAC only. Old-school RBAC tools don't support graph traversal. ABAC tools (OPA/Rego) require learning a policy language. Nobody unifies all three in one simple config.

**How Rune solves it: A 3-layer pipeline**

```
Request → ReBAC (graph) → RBAC (inheritance) → ABAC (conditions) → Decision
          "CAN they?"     "DOES role allow?"    "SHOULD we allow?"
```

**Layer 1 — ReBAC (exists today):** Graph-based. BFS traversal over tuples.
```
user:arjun → member → team:engineering → owner → project:x
```

**Layer 2 — RBAC (role inheritance):**
```yaml
roles:
  admin:
    inherits: [editor]
    actions: [manage, delete]
  editor:
    inherits: [viewer]
    actions: [edit]
  viewer:
    actions: [read]
```
`admin` automatically gets `edit` and `read` through inheritance. One config — no code.

**Layer 3 — ABAC (attribute conditions):**
```yaml
policies:
  - name: office-hours-only
    condition:
      time_between: ["09:00", "17:00"]
    effect: deny_outside

  - name: internal-network
    resources: [financial_report]
    condition:
      ip_in: "10.0.0.0/8"
    effect: require
```

**Example check flow:**
```
rune.can('user:arjun').do('read').on('report:Q4', { context: { time: '23:00' } })

Step 1 (ReBAC): arjun has 'viewer' on report:Q4   → ✅
Step 2 (RBAC):  'viewer' role allows 'read'        → ✅
Step 3 (ABAC):  time 23:00 is outside 09:00-17:00  → ❌ DENY

Final: DENY (reason: "outside office hours")
```

**What exists today:** All three layers are fully built. Set `mode: rbac`, `mode: abac`, `mode: rebac`, or `mode: hybrid` per resource in `rune.config.yml`. ABAC conditions support `time_between`, `ip_in`, and `resource`/`subject` attribute checks.

---

### 6. "Zero-sync — read from existing Postgres, no separate tuple store"

This is the same as Problem 3. See the **Zero-Sync** solution above.

**Why this matters:** Every competitor (Permit.io, SpiceDB, Auth0 FGA, OpenFGA) requires a separate data store. Rune is the only engine designed to read your existing tables. This eliminates the #1 reason developers resist adopting authorization tools.

---

### 7. "Non-developer UI for role management"

This is the same as Problem 2. See the **Admin Dashboard** solution above.

**Extra feature: Role Hierarchy Editor**

```
┌──────────────────────────────┐
│  Role Hierarchy              │
│                              │
│  👑 admin                    │
│   └── ✏️ editor              │
│        └── 👁️ viewer         │
│                              │
│  [+ Add Role]  [Edit Tree]   │
└──────────────────────────────┘
```

Non-devs can visually create and modify role trees. Changes apply immediately — no deploy needed.

---

### 8. "Affordable, predictable pricing for SMB/mid-market"

This is the same as Problem 4. See the **Self-Hosted Pricing** solution above.

**Future addition — Managed Cloud (for teams that don't want to self-host):**

| Tier | Price | For |
|---|---|---|
| Self-Hosted | Free forever | Startups, side projects |
| Cloud Pro | $49/mo | Teams that want us to host it |
| Enterprise | Custom | SLA, SOC2, dedicated support |

Even the managed option is 5-10x cheaper than Permit.io at scale.

---

### 9. "No out-of-box multi-tenant B2B SaaS starter"

**The industry problem:** If you're building a B2B SaaS (like Notion, Linear, Slack), you need:
- Tenant isolation (Company A can't see Company B's data)
- Per-tenant role configs (Acme uses admin/editor/viewer, TechCorp uses superadmin/user)
- Tenant admin portal (your customer's admin manages THEIR team's permissions)

Nobody gives you this out of the box. You always build it from scratch.

**How Rune solves it:**

**A) Tenant Onboarding API — one call to set up a new customer:**
```bash
POST /v1/tenants
{
  "name": "Acme Corp",
  "plan": "starter",
  "adminEmail": "admin@acme.com"
}

# Returns everything they need:
{
  "tenantId": "uuid-...",
  "apiKey": "rune_...",
  "adminUrl": "https://your-engine.com/admin?tenant=uuid-..."
}
```

**B) Per-Tenant Role Config — each customer has their own role hierarchy:**
```
Acme Corp:             TechStart Inc:
  admin                  superadmin
  └── editor               └── admin
       └── viewer                └── user
```

**C) Tenant Admin Portal — your customer's admin manages their own permissions:**
```
┌─────────────────────────────────────────────┐
│  🔐 Acme Corp — Permissions                │
│                                             │
│  Team Members:                              │
│  • arjun@acme.com    — Admin    [Change]    │
│  • priya@acme.com    — Editor   [Change]    │
│  • new@acme.com      — Viewer   [Change]    │
│                                             │
│  [+ Invite Member]  [Manage Roles]          │
└─────────────────────────────────────────────┘
```

This is the feature Permit.io charges **$500+/month** for. With Rune, it's included and self-hosted.

**What exists today:** Multi-tenant isolation is fully implemented (every query scoped by `tenant_id`, zero cross-tenant leakage). Tenant onboarding API (`POST /v1/tenants`) and per-tenant admin portal are on the roadmap.

---

## Summary

| # | Problem | Rune's Solution | Status |
|---|---|---|---|
| 1 | 3+ weeks to integrate | CLI (`rune init`, `rune validate`, `rune explain`) + SDK middleware | ✅ Solved |
| 2 | No UI for non-devs | Admin Dashboard embedded in engine — login, logs, directory, playground | ✅ Solved |
| 3 | Data sync nightmares | Zero-Sync — `SqlDataSource` reads your existing DB tables via config mappings | ✅ Solved |
| 4 | Unpredictable pricing | Self-hosted, you own the infra | ✅ Solved |
| 5 | No RBAC + ReBAC + ABAC | 3-layer pipeline: ReBAC (BFS) → RBAC (one-hop) → ABAC (conditions) | ✅ Solved |
| 6 | No zero-sync | `datasources` block in `rune.config.yml` maps your tables to tuples | ✅ Solved |
| 7 | No non-dev UI | Same as #2 | ✅ Solved |
| 8 | Expensive at scale | Same as #4 | ✅ Solved |
| 9 | No multi-tenant starter | Multi-tenant isolation done; tenant onboarding API + per-tenant portal coming | 🟡 Partial |

---

## Roadmap

| Phase | What | Status |
|---|---|---|
| **Phase 1** | Core engine + SDK + custom actions + resilience | ✅ Done |
| **Phase 2** | Admin Dashboard + RBAC + ABAC + CLI + Zero-Sync | ✅ Done |
| **Phase 3** | `npx create-rune` scaffolder + Tenant Onboarding API (`POST /v1/tenants`) + per-tenant admin portal | 🔵 Next |
| **Phase 4** | Managed Cloud tier + Python/Go SDKs + SOC 2 compliance | 🔴 Future |
