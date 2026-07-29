# Feature gaps hotfix 20260729b

## Fixes
1. MySQL `enabled = 'true'` returned **zero** competitor rows (BOOLEAN is 1/0).
2. Auto-seed catalogs from `samples/competitors/{product}.json` when DB empty.
3. Worker bundles fallback catalogs so gaps still generate if API fails.

## Upload A — Smoke API
Into smoke CodeIgniter root (`app/`, `samples/`):
- `app/Config/Routes.php`
- `app/Controllers/WorkerController.php`
- `app/Controllers/CompetitorProfilesController.php`
- `samples/competitors/*.json` (all files)

## Upload B — Worker
Into `/home/apisaicountly/public_html/worker.apis.aicountly.com/`:
- `portals/smoke/runSession.ts`
- `portals/smoke/reviewer/fallbackCompetitorCatalogs.ts` (new file)
- `portals/smoke/reviewer/featureGapEngine.ts`
- `portals/smoke/reviewer/competitorComparison.ts`

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
grep -n "fallbackCompetitorCatalogs\|bundled-fallback" portals/smoke/runSession.ts | head
pm2 restart qa-worker --update-env
```

## Verify
Re-run Sales / Invoices. View Log should show:
`Feature gap scan: source=api|bundled-fallback, N competitor catalog(s), … M gap(s)`
with M > 0. Reports ? Feature gaps table filled.
