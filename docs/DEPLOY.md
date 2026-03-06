# 🚀 Deploying Rune to Render

Complete, step-by-step guide to deploy the Rune authorization engine on [Render](https://render.com) — from zero to production.

---

## Prerequisites

Before you start, make sure you have:

- A [Render account](https://render.com) (free tier works)
- The Rune repo cloned locally (`git clone https://github.com/praveenraj-sk/Rune.git`)
- **psql** installed locally (`brew install postgresql` on macOS)
- **pnpm** installed (`npm install -g pnpm`)

---

## Step 1 — Create a PostgreSQL Database

1. Go to **https://dashboard.render.com**
2. Click **"New +"** (top right) → **"PostgreSQL"**
3. Fill in:
   | Field    | Value        |
   |----------|--------------|
   | Name     | `rune-db`    |
   | Region   | Singapore (or closest to your users) |
   | Plan     | Free         |
4. Click **"Create Database"**
5. Wait ~30 seconds for it to spin up

Once ready, go to the database's **Info** or **Connections** tab and copy two URLs:

| URL | What it's for |
|-----|---------------|
| **Internal Database URL** | Used by your Render web service (fast, private network) |
| **External Database URL** | Used from your local machine to run schema + setup |

> **⚠️ Keep the External URL private.** Anyone with it can access your database. After setup, you only need the Internal URL.

---

## Step 2 — Create the Database Schema (from your local machine)

Open a terminal, `cd` into the Rune project, and run:

```bash
cd /path/to/Rune

psql "YOUR_EXTERNAL_DATABASE_URL" -f packages/engine/src/db/schema.sql
```

You should see:
```
CREATE TABLE     ← tuples
CREATE INDEX     (×4)
CREATE SEQUENCE  ← lvn_seq
CREATE TABLE     ← schemas
CREATE TABLE     ← decision_logs
CREATE INDEX     (×4)
CREATE TABLE     ← api_keys
CREATE TABLE     ← permission_index
CREATE INDEX     ← idx_perm_granted_by
```

**Verify** all 5 tables exist:
```bash
psql "YOUR_EXTERNAL_DATABASE_URL" -c "\dt"
```

Expected output:
```
 Schema |       Name       | Type  |    Owner
--------+------------------+-------+-----------
 public | api_keys         | table | ...
 public | decision_logs    | table | ...
 public | permission_index | table | ...
 public | schemas          | table | ...
 public | tuples           | table | ...
```

---

## Step 3 — Run Setup (Create Your First Tenant + API Key)

Still from your local machine:

```bash
DATABASE_URL="YOUR_EXTERNAL_DATABASE_URL" pnpm run setup
```

It will prompt for a tenant name, then output:
```
  ✓ Setup complete!

  Tenant ID  84d1aef9-...
  API Key    rune_158Yy...

  ⚠️  Save your API key — it will not be shown again.
```

**Copy and save the API Key** somewhere safe (password manager, `.env.production`, etc.). You will need it to authenticate all API requests.

---

## Step 4 — Generate Secrets

Run these two commands **once** to generate random secrets:

```bash
# Salt for hashing API keys in the database
openssl rand -hex 32
# → copy this value, you'll use it as API_KEY_SALT

# Admin dashboard key (for the /dashboard UI)
openssl rand -hex 32
# → copy this value, you'll use it as ADMIN_API_KEY
```

---

## Step 5 — Create the Web Service

1. Go to **Render Dashboard → "New +" → "Web Service"**
2. Connect your GitHub repo: **`praveenraj-sk/Rune`**
3. Fill in:

   | Field         | Value          |
   |---------------|----------------|
   | Name          | `rune-engine`  |
   | Region        | Singapore (same as your database) |
   | Runtime       | Docker         |
   | Branch        | `main`         |
   | Plan          | Free           |

4. Add **Environment Variables** (click "Advanced" → "Add Environment Variable"):

   | Key                   | Value                                      |
   |-----------------------|--------------------------------------------|
   | `DATABASE_URL`        | *Internal Database URL from Step 1*        |
   | `PORT`                | `4078`                                     |
   | `NODE_ENV`            | `production`                               |
   | `API_KEY_SALT`        | *value from Step 4*                        |
   | `ADMIN_API_KEY`       | *value from Step 4*                        |
   | `MAX_CACHE_SIZE`      | `10000`                                    |
   | `MAX_BFS_DEPTH`       | `20`                                       |
   | `MAX_BFS_NODES`       | `1000`                                     |
   | `RATE_LIMIT_MAX`      | `100`                                      |
   | `RATE_LIMIT_WINDOW_MS`| `10000`                                    |

   > **IMPORTANT:** Use the **Internal** Database URL here (not External). Internal is faster and more secure within Render's network.

5. Click **"Create Web Service"** — Render will build and deploy your Docker image.

---

## Step 6 — Verify Deployment

Wait for the deploy to finish (2–3 minutes), then test:

```bash
# Health check (no auth required)
curl https://rune-engine.onrender.com/v1/health
# → {"status":"ok","db":"connected"}

# Test a permission check (use the API key from Step 3)
curl -X POST https://rune-engine.onrender.com/v1/can \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"subject":"user:test","action":"read","object":"doc:hello"}'
# → {"decision":"deny","status":"NOT_FOUND",...} (expected — no tuples yet)
```

---

## Step 7 — Use the SDK

Install and connect from any Node.js app:

```bash
npm install @runeauth/sdk
```

```typescript
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  'rune_158Yy...',  // API key from Step 3
  baseUrl: 'https://rune-engine.onrender.com',
})

// Grant access
await rune.allow({ subject: 'user:alice', relation: 'viewer', object: 'doc:report' })

// Check access
const result = await rune.can('user:alice').do('read').on('doc:report')
console.log(result.status) // "ALLOW"
```

---

## Redeployment

After pushing code changes to `main`, Render auto-deploys. To manually trigger:

**Render Dashboard → rune-engine → Manual Deploy → "Deploy latest commit"**

---

## Database Rotation (Credential Reset)

If your database credentials are ever leaked:

1. **Delete the old database** on Render (Settings → scroll to bottom → "Delete Database")
2. **Create a new database** (Step 1 above)
3. **Run schema + setup** again (Steps 2–3 above)
4. **Update `DATABASE_URL`** in your web service's Environment Variables with the new Internal URL
5. Render will auto-redeploy with the new connection

> **Tip:** The schema uses `IF NOT EXISTS` on all objects, so re-running `schema.sql` is always safe.

---

## Running Database Migrations

When new migrations are added (e.g. `004_*.sql`), run them from your local machine:

```bash
psql "YOUR_EXTERNAL_DATABASE_URL" -f packages/engine/src/db/migrations/004_whatever.sql
```

Migrations are idempotent — safe to run multiple times.

---

## Important Notes

| Note | Details |
|------|---------|
| **Cold starts** | Free Render instances spin down after 15 min of inactivity. First request after idle takes ~50 seconds. |
| **Free DB limit** | Free-tier Postgres databases expire after 90 days. Render will notify you before deletion. |
| **API_KEY_SALT** | Do NOT change this after issuing API keys — all existing keys will break (they're hashed with this salt). |
| **ADMIN_API_KEY** | If left blank, the `/dashboard` admin UI is disabled entirely (safe default for production). |
