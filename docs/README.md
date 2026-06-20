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
npm run smoke:observe
```

The portal lives at <http://localhost:5173>. The backend API at
<http://localhost:8080/api/v1>.

## 5. Bootstrap roles & first user

After `php spark db:seed InitialSeeder` you will have:

| Role               | Permissions                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `owner`            | Everything: settings, target profiles, vault, plan approval, run, reports   |
| `product_reviewer` | Profiles, plan approval, run observations, reports                          |
| `developer_viewer` | View reports only                                                           |
| `auditor_viewer`   | View only reports flagged `auditor_visible`                                  |

The seeder also creates an initial Owner:

```
email:    owner@aicountly.local
password: ChangeMe!2026   (force-rotate on first login)
```

Log in, change the password, then create real users from `/audit-logs` is
disabled — use the (deferred) `/users` admin page in v1 by inserting rows
directly via `php spark db:seed` extensions or by hitting `POST
/api/v1/users` from the Owner account.

## 6. The workflow

```
Login (smoke.aicountly.org)
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

| Mode                         | Allowed                               |
|------------------------------|---------------------------------------|
| `sandbox`                    | Observer + clicks + read-only actions |
| `gh_staging`                 | Observer + clicks + read-only actions |
| `production_readonly`        | Observer + clicks ONLY                |
| `production_restricted`      | Observer (no clicks beyond menus)     |

Production targets always show the red **PRODUCTION** banner and the worker
disables every restricted button via `SafeActionGuard`.

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
- Production targets force `read_only=true` and `observer_mode=true` regardless
  of other flags.

## 11. Convenience scripts

```bash
npm run smoke:observe                    # start worker poll loop
npm run smoke:run-session -- --session=42
npm run smoke:books                      # enqueue all approved books sessions
npm run smoke:hrms
npm run smoke:report -- --run-id=17
```

## 12. Out of scope for v1

- Real 2FA delivery (table column + endpoint stubbed).
- SMTP / email notifications.
- Live screenshot streaming (reports are post-run).
- Source code changes / bug fixing — explicitly forbidden by spec.
