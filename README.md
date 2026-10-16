# aicountly-smoke-app

**smoke.aicountly.org** — internal AI-assisted product observer portal for the
AICOUNTLY suite (sandbox / gh / books / hrms / auditor / fr / secretarial /
calendar / contacts, ...).

> Read-only by default. Logs into approved target apps, scans menus and screens,
> captures evidence, runs UX + feature-gap + competitor reviews, and produces
> session-wise plus consolidated product intelligence reports. **It does not
> rectify source code, modify app data, or apply fixes.**

- Frontend: React + Vite + TS + Tailwind — `frontend/`
- Backend: PHP 8.2 + CodeIgniter 4.6 — `backend/`
- Worker: Node 20 + TS + Playwright — `worker/`
- DB: PostgreSQL — `migrations/` (mirrors `backend/app/Database/Migrations/`)
- Reports output: `smoke-reports/`
- Sample prompts / sessions / competitor benchmarks: `samples/`
- Cross-system E2E harness (real Console, my.aicountly, Manage, Flow, Smart Books and Build on one
  machine; fakes only for e-mail, Tata Smartflo and S3): `e2e/` — `e2e/run.sh`, report in
  `e2e/report.md`, see [`e2e/README.md`](e2e/README.md)

See [`docs/README.md`](docs/README.md) for full setup, the workflow, roles,
and security notes.

**Access:** Console SSO only, and **Console assigns Smoke roles** (Console →
Roles & Access, app code `smoke`: `owner`, `product_reviewer`,
`developer_viewer`, `auditor_viewer`). Roles are replaced from Console at every
sign-in and re-checked on every token refresh (access tokens live at most 15
minutes). Production must set `CONSOLE_API_URL` and `CONSOLE_API_TOKEN`
(per-product key, capability `staff.roles`) in the API `.env`. Details:
[docs/README.md § 5](docs/README.md#5-roles-assigned-in-console--first-user).

## Quick start

```bash
cp .env.example .env       # fill in DB / JWT / vault / AI keys / worker token
cd backend && composer install && php spark migrate && php spark db:seed InitialSeeder && cd ..
npm --workspace frontend install
npm --workspace worker install && npx playwright install chromium --with-deps
npm run backend:serve      # :8080
npm run frontend:dev       # :5173
cp worker/.env.example worker/.env
npm run smoke:observe      # worker (dev poll loop)
```

## Workflow

```
Login -> Target Profile -> Master Prompt -> Brain ensemble session plan
      -> Approve -> Sequential Playwright runs -> Per-session reports
      -> Final consolidated report (HTML + JSON)
```
