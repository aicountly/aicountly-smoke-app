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

See [`docs/README.md`](docs/README.md) for full setup, the workflow, role
bootstrap, and security notes.

## Quick start

```bash
cp .env.example .env       # fill in DB / JWT / vault / AI keys / worker token
cd backend && composer install && php spark migrate && php spark db:seed InitialSeeder && cd ..
npm --workspace frontend install
npm --workspace worker install && npx playwright install chromium --with-deps
npm run backend:serve      # :8080
npm run frontend:dev       # :5173
npm run smoke:observe      # worker
```

## Workflow

```
Login -> Target Profile -> Master Prompt -> Brain ensemble session plan
      -> Approve -> Sequential Playwright runs -> Per-session reports
      -> Final consolidated report (HTML + JSON)
```
