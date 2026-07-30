# smoke.aicountly.org — Internal Observer Portal

Internal AI-assisted product observer for AICOUNTLY apps. Logs into approved target
apps in **observer mode**, scans menus / screens / actions, captures screenshots,
runs UX + feature-gap + competitor reviews, and produces session-wise plus
consolidated product intelligence reports.

> **Read-only by default.** This portal does not rectify source code, modify app
> data, alter databases, or apply fixes. Save / Submit / Delete / Approve / Post
> and similar destructive actions are blocked by `SafeActionGuard` unless an
> Owner explicitly enables safe demo mode for a non-production session.

See the full setup guide at [`docs/README.md`](README.md) (this file). For
architecture and module list see the project plan and the high-level diagram in
the root README of the workspace.

---

## 1. Stack

| Layer       | Tech                                                  |
|-------------|-------------------------------------------------------|
| Frontend    | React 18 + Vite + TypeScript + TailwindCSS            |
| Backend     | PHP 8.2 + CodeIgniter 4.6 (REST, JWT auth)            |
| Database    | PostgreSQL 14+                                        |
| Worker      | Node 20 + TypeScript + Playwright (Chromium)          |
| AI brain    | OpenAI + Perplexity in parallel, arbited by Gemini    |

The brain is a pluggable **council**: providers run in parallel, the arbiter
synthesises the final decision. Drivers selectable per-call via `.env` and the
Settings page.

## 2. Prerequisites

- Node.js >= 20, npm >= 10
- PHP >= 8.2 with extensions: `pgsql`, `intl`, `mbstring`, `curl`, `openssl`
- Composer 2.x
- PostgreSQL >= 14
- Git
- (Worker) `npx playwright install chromium`

## 3. First-time setup

```bash
# 1. clone & install root deps
git clone <repo> aicountly-smoke-app
cd aicountly-smoke-app
cp .env.example .env       # edit DB creds, JWT_SECRET, SMOKE_VAULT_KEY, AI keys, WORKER_SHARED_TOKEN

# 2. backend
cd backend
composer install
cp env .env                # CodeIgniter env file (already references parent .env values where needed)
php spark migrate
php spark db:seed InitialSeeder
cd ..

# 3. frontend
npm --workspace frontend install

# 4. worker
npm --workspace worker install
npx playwright install chromium --with-deps
cp worker/.env.example worker/.env   # set WORKER_SHARED_TOKEN + WORKER_BACKEND_URL
```

### Generating secrets

```bash
# JWT secret (64 random hex chars)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Vault master key (exactly 32 bytes / 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Worker shared token
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 4. Running locally

Open three terminals:

```bash
# Terminal 1 — backend API on :8080
npm run backend:serve

# Terminal 2 — frontend on :5173
npm run frontend:dev

# Terminal 3 — observer worker (long-running poll loop)
cp worker/.env.example worker/.env   # WORKER_BACKEND_URL=http://localhost:8080/api/v1
npm run smoke:observe
```

The portal lives at <http://localhost:5173>. The backend API at
<http://localhost:8080/api/v1>.

### Production worker (cPanel)

The live smoke worker runs on the **same cPanel account as the portal and API**,
from `${PROD_REMOTE_ROOT}/worker/`, under PM2 as **`aicountly-smoke-worker`**,
executing compiled output (`npm start` → `node dist/index.js`).

The deploy workflow owns it end to end: it builds `worker/dist/`, rsyncs it with
`--delete`, installs production dependencies and Chromium on the server, then runs
`pm2 startOrRestart worker/ecosystem.config.cjs --update-env` + `pm2 save` and
verifies via `pm2 jlist` that the process is `online` and not restart-looping. No
files are ever uploaded by hand, which is the whole point: hand-picked uploads to
the old host silently shipped half-applied builds (a wrong-product login fix and a
screen-visit-budget fix both "deployed green" and never went live).

Process identity lives in [`worker/ecosystem.config.cjs`](../worker/ecosystem.config.cjs)
— `instances: 1` is mandatory, since two instances would double-lease the same job
queue.

#### One-time server bootstrap

Nothing below can be automated by the workflow; do it once over SSH:

```bash
cd "${PROD_REMOTE_ROOT}/worker"

cp .env.example .env
# WORKER_BACKEND_URL=https://smoke.aicountly.org/api/v1
# WORKER_SHARED_TOKEN=<identical to WORKER_SHARED_TOKEN in ../api/.env>
# WORKER_ID=aicountly-smoke-worker
# leave REPORTS_DIR unset

npm install -g pm2                     # per cPanel account
npx playwright install-deps chromium   # ONCE, as root (system libraries)

pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
pm2 startup                            # resurrect after a server reboot
```

The deploy skips the restart with a `::warning::` (never a failure) when
`worker/.env` is missing or `pm2` is not on the deploy shell's `PATH`, so a worker
prerequisite can never block the frontend/API deploy — but the run turns red at the
end if PM2 reports the process is not online.

#### Cutover from the retired shared worker

The old shared multi-portal worker on `worker.apis.aicountly.com` (cPanel account
`apisaicountly`) **must stop leasing smoke jobs** — `pm2 delete` its smoke process
there, or point it away from this API. Two workers polling the same queue
double-lease it: sessions of one run get split across two hosts running different
builds, and reports interleave.

Confirm which worker served a run in the portal: **Run detail → Sessions → Worker**
shows `leased_by`, i.e. the worker's `WORKER_ID`. It must read
`aicountly-smoke-worker`. Anything else means the retired worker is still alive.

`npm run worker:pack` is **legacy** — it only builds upload bundles for the retired
host and is kept for reference.

`REPORTS_DIR` needs no configuration: the worker default (`cwd/..` +
`smoke-reports`, with PM2 cwd `${PROD_REMOTE_ROOT}/worker`) and the API default
(`api/.env` `REPORTS_DIR = ../smoke-reports`, relative to CodeIgniter `ROOTPATH` =
`${PROD_REMOTE_ROOT}/api/`) both resolve to `${PROD_REMOTE_ROOT}/smoke-reports`. If
you override one side, override both or the Reports page cannot find screenshots.

See [`worker/README.md`](../worker/README.md) for full setup.

## 5. Bootstrap roles & first user

After `php spark db:seed InitialSeeder` you will have:

| Role               | Permissions                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `owner`            | Everything: settings, target profiles, vault, plan approval, run, reports   |
| `product_reviewer` | Profiles, plan approval, run observations, reports                          |
| `developer_viewer` | View reports only                                                           |
| `auditor_viewer`   | View only reports flagged `auditor_visible`                                  |

Access is via **Console SSO** (local email/password login is disabled). The
seeder may still create a bootstrap Owner row for DB/role wiring:

```
email:    owner@aicountly.local
password: ChangeMe!2026
```

Owners manage portal users and roles from the `/users` page (or `POST /api/v1/users`).

## 6. The workflow

```
Console SSO → smoke.aicountly.org
   |
   v
Create / select Target App Profile  (owner / product_reviewer)
   |
   v
Submit master prompt + select environment
   |
   v
BrainEnsemble (OpenAI + Perplexity -> Gemini) generates session plan
   |
   v
Review / edit / split / merge / reorder / APPROVE
   |
   v
Sequential observer runner (one session at a time)
   |
   v
Per-session report (HTML + JSON)  ->  Final consolidated report
   |
   v
/smoke-reports/{product}/{date}/{run_code}/
```

## 7. Environment modes

| Mode                         | Allowed                                    |
|------------------------------|--------------------------------------------|
| `sandbox`                    | Observer + clicks + read-only actions      |
| `gh_staging`                 | Observer + clicks + read-only actions      |
| `production_readonly`        | Observer + clicks ONLY                     |
| `production_restricted`      | Observer (no clicks beyond menus)          |
| `production_full_access`     | Observer + full access (opt-in destructive)|

Every `production_*` tier shows the red **PRODUCTION** banner. The read-only and
restricted tiers are observer-only: `SafeActionGuard` disables every restricted
button, file I/O is refused outright, and `destructive_allowed` cannot be turned
on (403 from `ProductionGuardFilter`).

`production_full_access` is for a live target you own. It keeps the banner but
behaves like a sandbox: restricted labels are clickable and file I/O is
available. It is not automatic — the profile must set `allow_safe_demo=true` and
the session must set `destructive_allowed=true`, exactly as in sandbox. Tier
membership is defined once in `Config\Environments` (backend),
`worker/src/utils/environments.ts`, and `frontend/src/lib/environments.ts`; never
branch on `startsWith('production')`, which would sweep this tier back into the
observer-only rules.

### File I/O smoke tests

Every SaaS product has a synthetic fixture scenario under `samples/fixtures/`.
File I/O sessions detect upload/import/download/export controls, materialize a
run-scoped fixture copy, and record hash, MIME, size, structure, and AI quality
results in `smoke_file_io_tests`.

- Detection is always read-only.
- Downloads/exports require a profile outside the observer-only tiers and the
  matching `allowed_actions` entry.
- Uploads/imports require `sandbox`, `gh_staging` or `production_full_access`,
  profile `allow_safe_demo=true`, session `destructive_allowed=true`, the
  matching `allowed_actions` entry, and an operator approval remembered per
  product/module.
- `production_readonly` and `production_restricted` uploads/imports are
  unconditionally blocked; there is no owner override.

Enable a safe test by turning on **Allow safe demo** on the target profile,
adding upload/import actions to the File I/O session, and enabling its
destructive toggle before approval. Use only the bundled synthetic fixtures.

### Unexpected forms

A run opens screens nobody wrote a rule for, so it will meet forms nobody
anticipated. It fills them itself rather than stopping:

1. **Field heuristics** (`worker/src/forms/fieldSynthesis.ts`) read each field's
   name, id, placeholder, aria-label and `<label>` and answer what they
   recognise — names, addresses, financial-year dates, contacts, quantities,
   amounts, references, free text. Money and quantities are always 0 or 1.
2. **The brain** (`form_fill` task) is asked only about required fields the
   heuristics could not map, and is sent field labels and types — never page
   content. Its answers are filtered back through the same safety rules, so it
   can fill a gap but never overrule a refusal.
3. **A last-resort placeholder** answers any required field still unanswered, so
   an unreadable label cannot block the screen behind the form.

Two categories are never filled, whatever the label says: credentials, OTPs,
CAPTCHAs, API keys and search boxes; and checksum or registry identifiers
(GSTIN, CIN, TIN, Aadhaar, bank account, IFSC, UPI, SWIFT, card numbers) — an
invented one is rejected anyway and reads worse in a report than the form's own
validation message.

Filling is safe everywhere; **submitting is not**, so it runs through the same
`SafeActionGuard` check as any other click on the submit control's own label.
That means `Save`/`Submit`/`Confirm` need a non-observer tier plus
`allow_safe_demo` and `destructive_allowed`, while a plain `Next`/`Continue`
works anywhere. When the guard says no, the form is filled as evidence and then
closed so the run continues. A rejected submit is retried once using the form's
own validation text, then screenshotted and reported.

### Autonomous decisions

When the run meets a situation it cannot resolve — an empty company picker, a
click it cannot land — it takes the recommended option and records it in
`smoke_run_decisions` with `source=auto`, shown as **Decided by the run**.

It only ever chooses an option this target permits. Ending a session is always a
human call, and creating a company on its own needs `sandbox`, `gh_staging` or
`production_full_access`. Where an option is closed to it, the run falls back
through dismiss → navigate → open → skip → rescan rather than attempting it and
failing on a guard it was never going to pass.

Deciding alone stops where it stops helping. If every option still open to the
run only gives up on the screen — skip or rescan — while an operator could have
unblocked it, the run asks instead of skipping quietly; otherwise it would hand
back a green session that observed nothing. That is the empty-picker case on an
observer-only tier: only a human may approve the company, so only a human is
asked. Answer once and it is remembered for the rest of the run. If nobody
answers within 30 minutes the run continues with the fallback and the decision
stays recorded as `timed_out`, so the report shows it went unanswered.

Set `SMOKE_AUTONOMOUS=false` to go back to parking the job and waiting up to 30
minutes for an operator on every unexpected screen.

## 8. Run identifiers

Every run gets a unique code: `SMOKE-RUN-YYYYMMDD-NNNN` (4-digit daily counter
managed atomically in `smoke_settings`). All artefacts and reports key off this
code.

## 9. Reports filesystem layout

```
smoke-reports/
  books/
    2026-06-19/
      SMOKE-RUN-20260619-0001/
        index.html             # final consolidated
        report.json            # final consolidated
        sessions/
          01-dashboard.html
          01-dashboard.json
          02-sales.html
          ...
        screenshots/
          *.png
        evidence/
          *.json
        fixtures/              # run-scoped copies; samples are never mutated
        downloads/             # downloaded/exported artifacts
```

## 10. Security notes

- Target credentials are encrypted with **AES-256-GCM**; `SMOKE_VAULT_KEY` is
  the master key (32 bytes). Each row has its own random nonce + auth tag.
  Plaintext is decrypted only inside the worker, just before `page.fill(...)`,
  and never logged.
- The portal has its **own** authentication. It never proxies to or trusts
  `my.aicountly.com`.
- Worker calls into the backend with `WORKER_SHARED_TOKEN` (in addition to a
  per-job lease ID). The worker never sees AI provider API keys.
- All mutating endpoints are gated by `RbacFilter`. All actions are recorded
  in `smoke_audit_logs`.
- `production_readonly` and `production_restricted` targets force
  `read_only=true` and `observer_mode=true` regardless of other flags.
  `production_full_access` does not, so it can exercise a live target you own.

## 11. Convenience scripts

```bash
npm run smoke:observe                    # start worker poll loop
npm run smoke:run-session -- --session=42
npm run smoke:books                      # start run from latest approved books plan
npm run smoke:hrms                       # same for hrms (requires worker token + approved plan)
npm run smoke:report -- --run-id=17
```

## 12. Out of scope for v1

- Real 2FA delivery (table column + endpoint stubbed).
- SMTP / email notifications.
- Live screenshot streaming (reports are post-run).
- Source code changes / bug fixing — explicitly forbidden by spec.
