# Smoke Playwright worker

Polls **smoke.aicountly.org** for queued observation sessions and runs them one at a time with Playwright.

## Production path (cPanel)

```
${PROD_REMOTE_ROOT}/worker/
```

This folder is **not** a public website — it is a long-running Node process. Keep `worker/.env` on the server only (deploy never writes it).

Reports are written under `REPORTS_DIR` (see `.env.example`). The API also stores report metadata in PostgreSQL.

## Setup (AlmaLinux / WHM)

```bash
cd /home/YOUR_CPANEL_USER/public_html/worker
cp .env.example .env
# Edit .env — set WORKER_SHARED_TOKEN (same as ../api/.env)

npm install --omit=dev
npx playwright install-deps chromium   # once, as root
npx playwright install chromium        # as cPanel user

node dist/index.js                     # one-shot test
./scripts/start-worker.sh              # poll loop (foreground)
```

Or use the npm production entry:

```bash
npm start
```

## PM2 (keep online)

```bash
npm install -g pm2
cd /home/YOUR_CPANEL_USER/public_html/worker
pm2 start npm --name smoke-worker -- start
pm2 save
pm2 startup
```

After each deploy that updates `worker/dist/`, restart:

```bash
pm2 restart smoke-worker
```

## Local development

From the repo root:

```bash
cp worker/.env.example worker/.env
# WORKER_BACKEND_URL=http://localhost:8080/api/v1
# WORKER_SHARED_TOKEN=<same as backend/.env>

npm run smoke:observe
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Production poll loop (`node dist/index.js`) |
| `npm run observe` | Dev poll loop via tsx (no build required) |
| `npm run dev` | Dev poll loop with file watch |
| `npm run run-session` | Run one leased session, then exit |
| `npm run enqueue -- --product=books` | Start a run from the latest approved plan (`POST /worker/enqueue`) |
| `npm run playwright:install` | Download Chromium + OS deps |

AI enrichment during a session calls `POST /worker/brain/invoke` (shared token);
provider keys stay on the PHP API only.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `WORKER_BACKEND_URL` | API base URL the worker polls |
| `WORKER_SHARED_TOKEN` | Must match `WORKER_SHARED_TOKEN` in `api/.env` |
| `WORKER_ID` | Stable worker name sent on lease requests |
| `REPORTS_DIR` | Filesystem root for HTML/JSON/screenshots |
