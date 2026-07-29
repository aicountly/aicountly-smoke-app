# worker.apis.aicountly.com

Shared Playwright worker for AICOUNTLY portals. **One install, one PM2 process.**

Portals are enabled by `.env` — do **not** create sibling folders like `smoke-worker` or per-app subfolders.

| Portal | Env | Polls |
|--------|-----|--------|
| QA | `QA_API_URL` + `QA_WORKER_TOKEN` | `https://qa.aicountly.org/api` |
| Smoke | `SMOKE_API_URL` + `SMOKE_WORKER_TOKEN` | `https://smoke.aicountly.org/api/v1` |

Enable one or both. The worker runs **one job at a time**, round-robin across enabled portals.

## Production path (cPanel)

```
/home/apisaicountly/public_html/worker.apis.aicountly.com/
```

This folder is **not** a public website — it is a long-running Node process.

### Evidence / reports

- **QA:** worker captures locally under `QA_REPORTS_DIR`, then **uploads** to the QA API. Permanent storage is on `qa.aicountly.org`.
- **Smoke:** observation paths come from Smoke API `REPORTS_DIR` (on `smokeaicountly`). Live Log reads files on the Smoke host. Ensure that directory is writable by this worker process when both accounts share a server (or add upload later).

## Setup (AlmaLinux / WHM)

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
cp .env.example .env
# Edit .env:
#   QA_WORKER_TOKEN     = same as qa server-php/.env QA_WORKER_TOKEN
#   SMOKE_WORKER_TOKEN  = same as smoke api/.env WORKER_SHARED_TOKEN
#   SMOKE_API_URL       = https://smoke.aicountly.org/api/v1

npm install
npx playwright install-deps chromium   # once, as root
npx playwright install chromium        # as apisaicountly user

npm run qa:run-session                 # one-shot QA test
npm run smoke:run-session              # one-shot Smoke test
npm start                              # multi-portal poll loop
```

## PM2 (keep online)

```bash
npm install -g pm2
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
pm2 start npm --name aicountly-qa-worker -- start
# After pulling multi-portal changes:
pm2 restart aicountly-qa-worker
pm2 save
pm2 startup
```

(The PM2 name may stay `aicountly-qa-worker` for continuity; it is the shared worker.)

## Enable Smoke on an existing server

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com

# Append Smoke portal (use the token already in smoke api/.env — do not regenerate)
SMOKE_TOKEN=$(grep -E '^WORKER_SHARED_TOKEN=' /home/smokeaicountly/public_html/api/.env | cut -d= -f2-)

grep -q '^SMOKE_API_URL=' .env || cat >> .env <<EOF

# Smoke portal
SMOKE_API_URL=https://smoke.aicountly.org/api/v1
SMOKE_WORKER_TOKEN=${SMOKE_TOKEN}
SMOKE_LEASE_SECONDS=600
EOF

# If keys exist, update token only:
sed -i "s|^SMOKE_WORKER_TOKEN=.*|SMOKE_WORKER_TOKEN=${SMOKE_TOKEN}|" .env
sed -i 's|^SMOKE_API_URL=.*|SMOKE_API_URL=https://smoke.aicountly.org/api/v1|' .env

# Deploy updated code, then:
pm2 restart aicountly-qa-worker
pm2 logs aicountly-qa-worker --lines 40
```

Expect startup lines like:

```text
[worker] portals=[qa, smoke]
[worker] smoke api=https://smoke.aicountly.org/api/v1
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Multi-portal poll loop |
| `npm run qa:run-session` | One job from any enabled portal (QA preferred in rotate 0) |
| `npm run smoke:run-session` | One Smoke job only |
| `npm run qa:basic-check` | QA prod-safe login + nav |
| `npm run playwright:install` | Download Chromium |

## Related repos

- **QA portal:** [aicountly-qa](https://github.com/aicountly/aicountly-qa)
- **Smoke portal:** [aicountly-smoke-app](https://github.com/aicountly/aicountly-smoke-app)
- **This repo:** apis.aicountly.com services (PDF, shared worker, …)
