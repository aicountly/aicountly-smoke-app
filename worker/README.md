# Smoke Playwright worker

Polls **smoke.aicountly.org** for queued observation sessions and runs them one at a time with Playwright.

## Production path (cPanel)

```
${PROD_REMOTE_ROOT}/worker/          ← this account, same as the portal and API
```

This folder is **not** a public website — it is a long-running Node process, run by
PM2 as **`aicountly-smoke-worker`** from compiled output (`npm start` →
`node dist/index.js`; `tsx` is dev-only). Keep `worker/.env` on the server only —
the deploy never writes it.

Reports go under `REPORTS_DIR` (see `.env.example`; leave it unset on cPanel). The
API also stores report metadata in PostgreSQL.

## Deploys restart this worker

`.github/workflows/deploy-prod-cpanel.yml` (manual dispatch) builds `worker/dist/`,
rsyncs it with `--delete`, installs production deps + Chromium on the server, then:

```bash
cd "${PROD_REMOTE_ROOT}/worker"
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
```

and then checks `pm2 jlist` twice to confirm `aicountly-smoke-worker` is `online`
and its `restart_time` is not climbing. So **there is nothing to upload by hand and
nothing to restart by hand.** If `worker/.env` is missing or `pm2` is not on the
deploy shell's `PATH`, the restart is skipped with a `::warning::` (the frontend/API
deploy is never blocked by a worker prerequisite) — but the run fails at the end if
PM2 says the process is not online, so a stale worker can never look green.

Process identity, cwd, log paths and `instances: 1` live in
[`ecosystem.config.cjs`](ecosystem.config.cjs). One instance is mandatory: two would
double-lease the same job queue. Logs land in `logs/worker-out.log` and
`logs/worker-error.log` (timestamped).

## One-time server bootstrap

```bash
cd "${PROD_REMOTE_ROOT}/worker"

cp .env.example .env
# WORKER_SHARED_TOKEN must equal WORKER_SHARED_TOKEN in ../api/.env
# WORKER_ID=aicountly-smoke-worker
# leave REPORTS_DIR unset

npm install -g pm2                     # per cPanel account
npm install --omit=dev                 # deploy repeats this, fine to run now
npx playwright install-deps chromium   # ONCE, as root — system libraries
npx playwright install chromium        # as the cPanel user

pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
pm2 startup                            # survive a server reboot
```

Useful afterwards: `pm2 logs aicountly-smoke-worker`, `pm2 describe
aicountly-smoke-worker`.

## Cutover from the retired shared worker

Smoke jobs used to be served by the shared multi-portal worker on
`worker.apis.aicountly.com` (cPanel account `apisaicountly`, TypeScript via `tsx`
from `portals/smoke/`). That host is **retired for smoke**, because hand-picked file
uploads there repeatedly shipped half-applied builds.

Stop it from leasing smoke jobs (`pm2 delete` its smoke process, or repoint its
`WORKER_BACKEND_URL`) **before** relying on this one. While both poll the same API
they double-lease the queue: one run's sessions get split across two hosts running
different code, and the reports interleave. Note the unrelated `buddy-worker`
process on that host is a different app — do not touch it.

To see which worker served a run, open the portal → Run detail → **Sessions →
Worker** column (`leased_by`). It must show `aicountly-smoke-worker`.

`npm run worker:pack` / `scripts/pack-apis-bundle.mjs` are **legacy**: they only
build upload bundles for the retired `worker.apis.aicountly.com` host. Nothing in
the current deploy path uses them.

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
| `npm run worker:pack` (root) | **Legacy** — upload bundle for the retired `worker.apis.aicountly.com` host |

AI enrichment during a session calls `POST /worker/brain/invoke` (shared token);
provider keys stay on the PHP API only.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `WORKER_BACKEND_URL` | API base URL the worker polls |
| `WORKER_SHARED_TOKEN` | Must match `WORKER_SHARED_TOKEN` in `api/.env` |
| `WORKER_ID` | Worker name sent on every lease; shown in the portal's Worker column. Use `aicountly-smoke-worker` |
| `REPORTS_DIR` | Filesystem root for HTML/JSON/screenshots. Leave unset on cPanel — the default matches the API's `../smoke-reports` |
| `SMOKE_ROOT_RELATIVE` | Path from the process cwd to the directory holding `samples/` and `smoke-reports/` (default `..`) |
