# 🚀 Deploying Rune to Render

Step-by-step instructions to deploy the Rune engine on [Render](https://render.com).

---

## 1. Create a Postgres Database

1. Go to **Render Dashboard → New → PostgreSQL**
2. Fill in:
   - **Name:** `rune-db`
   - **Region:** Singapore
   - **Plan:** Free
3. Click **Create Database**
4. Copy the **Internal Database URL** (starts with `postgresql://...`)

---

## 2. Create the Web Service

1. Go to **Dashboard → New → Web Service**
2. Connect your GitHub repo: `praveenraj-sk/Rune`
3. Fill in:
   - **Name:** `rune-engine`
   - **Region:** Singapore
   - **Language (Runtime):** Docker
   - **Branch:** `main`
   - **Plan:** Free
4. Add **Environment Variables:**

   | Key              | Value                                      |
   |------------------|--------------------------------------------|
   | `DATABASE_URL`   | *paste Internal DB URL from Step 1*        |
   | `PORT`           | `4078`                                     |
   | `NODE_ENV`       | `production`                               |
   | `API_KEY_SALT`   | *run `openssl rand -hex 32`, paste result* |
   | `SETUP_SECRET`   | *run `openssl rand -hex 32`, paste result* |
   | `MAX_CACHE_SIZE` | `10000`                                    |
   | `MAX_BFS_DEPTH`  | `20`                                       |
   | `MAX_BFS_NODES`  | `1000`                                     |

5. Click **Create Web Service**

---

## 3. Verify Health

```bash
curl https://rune-engine.onrender.com/v1/health
# → {"status":"ok","db":"connected"}
```

---

## 4. Run Setup (Create Tables + API Key)

Since Render's Shell is a paid feature, use the setup endpoint:

```bash
curl -X POST https://rune-engine.onrender.com/v1/setup \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_SETUP_SECRET>" \
  -d '{"tenantName": "my-app"}'
```

**Save the API key from the response** — it will not be shown again.

---

## 5. Give Your Friend Access

Tell them to install the SDK and use the API key:

```bash
npm install @runeauth/sdk
```

```typescript
import { Rune } from '@runeauth/sdk'

const rune = new Rune({
  apiKey:  '<API_KEY_FROM_STEP_4>',
  baseUrl: 'https://rune-engine.onrender.com',
})

// Check a permission
const result = await rune.can('user:arjun').do('read').on('shipment:TN001')
console.log(result.status) // "ALLOW" or "DENY"
```

---

## Notes

- Free Render instances **spin down after 15 minutes of inactivity**. The first request after idle takes ~50 seconds.
- To re-deploy after code changes, push to `main` — Render auto-deploys.
- To manually redeploy: **Render Dashboard → Manual Deploy → Deploy latest commit**.
