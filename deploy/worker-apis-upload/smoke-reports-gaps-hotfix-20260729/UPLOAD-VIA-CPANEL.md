# Feature gaps + Screenshots hotfix (2026-07-29)

## What was wrong

1. **Feature gaps empty** — worker called JWT-only `GET /competitors` with `X-Worker-Token` → **401** (logged as `benchmarks fetch failed`). Gap detection never got catalogs.
2. **Screenshots empty in Reports** — HTML used basename-only `<img src="file.png">` inside an iframe `srcDoc`, which cannot load files. Screenshots were often **captured and stored**, but the Reports preview could not display them.

## Upload A — Smoke API (`smoke.aicountly.org`)

From `files-to-upload/smoke-api/` into the Smoke CodeIgniter app root (where `app/` and `samples/` live), e.g.:

`/home/smokeaicountly/public_html/` (adjust to your real smoke API path)

| Local | Server |
|---|---|
| `app/Config/Routes.php` | `app/Config/Routes.php` |
| `app/Controllers/WorkerController.php` | `app/Controllers/WorkerController.php` |
| `app/Controllers/ReportsController.php` | `app/Controllers/ReportsController.php` |
| `app/Services/Reports/SessionReportBuilder.php` | `app/Services/Reports/SessionReportBuilder.php` |
| `samples/reports/session.html.tpl` | `samples/reports/session.html.tpl` |

No PM2 restart needed for PHP (opcache may need a moment / `php -r` clear if you use opcache reset).

## Upload B — Worker (`worker.apis.aicountly.com`)

From `files-to-upload/worker/` into:

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

| Local | Server |
|---|---|
| `portals/smoke/runSession.ts` | `portals/smoke/runSession.ts` |
| `portals/smoke/reporter/sessionReportBuilder.ts` | `portals/smoke/reporter/sessionReportBuilder.ts` |
| `portals/smoke/reviewer/featureGapEngine.ts` | `portals/smoke/reviewer/featureGapEngine.ts` |
| `portals/smoke/reviewer/competitorComparison.ts` | `portals/smoke/reviewer/competitorComparison.ts` |

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
grep -n "worker/competitors" portals/smoke/runSession.ts | head
pm2 restart qa-worker --update-env
```

## Ops checklist

1. **Competitor Benchmarks** must exist for the run’s `product_name` (e.g. `books`). Portal → Competitor Benchmarks, or seed `CompetitorBenchmarksSeeder`.
2. Re-run an observation session after both uploads.
3. View Log should show: `Feature gap scan: N competitor catalog(s), … M gap(s)`.
4. Reports preview should show screenshot images (data URIs). Existing reports: refresh Reports page — `ReportsController` rewrites basename imgs when PNGs exist under `REPORTS_DIR`.

## How to tell “empty” vs “not stored”

| Check | Meaning |
|---|---|
| Session Log → screenshots visible | Files are stored; Reports HTML was the bug |
| Session Log → “No screenshots” | Files missing on Smoke `REPORTS_DIR` (worker write path / permissions) |
| Worker log `benchmarks fetch failed: 401` | Old worker still hitting JWT `/competitors` |
| Worker log `No competitor benchmarks for product` | Seed catalogs / fix product_name |
