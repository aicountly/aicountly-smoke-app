# Smoke mid-run decisions + report readability (2026-07-29c)

Supersedes `smoke-midrun-decisions-20260729` (worker-only). This package includes **Smoke API + frontend + worker** so cPanel rollout does not miss migrations, decision screenshot APIs, report templates, or reporter dependencies.

## Hosts

| Host | Role |
|---|---|
| `smoke.aicountly.org` | Smoke CodeIgniter API + report samples (+ frontend build if served from same tree) |
| `worker.apis.aicountly.com` | Global/qa worker that runs `portals/smoke/*` |

## Upload order (required)

1. **Smoke API first** (migrations + routes/controllers must exist before worker creates decisions)
2. Run migrations on Smoke API
3. Upload + rebuild frontend (if frontend is deployed separately, do that next)
4. Upload worker files, then restart PM2

---

## Upload A — Smoke API (`smoke.aicountly.org`)

From `files-to-upload/smoke-api/` into the Smoke CodeIgniter app root (where `app/` and `samples/` live), e.g.:

`/home/smokeaicountly/public_html/`

Preserve relative paths under `app/` and `samples/`.

### Critical paths

| Local | Server |
|---|---|
| `app/Config/Routes.php` | `app/Config/Routes.php` |
| `app/Controllers/DecisionsController.php` | `app/Controllers/DecisionsController.php` |
| `app/Controllers/WorkerController.php` | `app/Controllers/WorkerController.php` |
| `app/Controllers/ObservationRunsController.php` | `app/Controllers/ObservationRunsController.php` |
| `app/Controllers/UxIssuesController.php` | `app/Controllers/UxIssuesController.php` |
| `app/Controllers/FeatureGapsController.php` | `app/Controllers/FeatureGapsController.php` |
| `app/Services/Reports/DecisionReportFormatter.php` | `app/Services/Reports/DecisionReportFormatter.php` **(new)** |
| `app/Services/Reports/SessionReportBuilder.php` | `app/Services/Reports/SessionReportBuilder.php` |
| `app/Services/Reports/FinalReportBuilder.php` | `app/Services/Reports/FinalReportBuilder.php` |
| `app/Services/Runner/RunOrchestrator.php` | `app/Services/Runner/RunOrchestrator.php` |
| `app/Database/Migrations/2026-07-29-120000_*` … `120030_*` | same under `app/Database/Migrations/` |
| `samples/reports/session.html.tpl` | `samples/reports/session.html.tpl` |
| `samples/reports/final.html.tpl` | `samples/reports/final.html.tpl` |

Also upload the remaining `app/` files in this package (`Filters`, `Brain`, `Config/Products.php`, other controllers) to stay aligned with the mid-run branch.

### Migrate

```bash
cd /home/smokeaicountly/public_html   # adjust path
php spark migrate
```

Confirm tables/columns:

- `smoke_run_decisions`
- `smoke_decision_memory`
- `smoke_feature_gaps` cursor/human fields
- `smoke_ux_issues` / gaps `human_summary` (per `120030`)

No PM2 restart needed for PHP (opcache may take a moment).

---

## Upload B — Frontend (`smoke.aicountly.org` UI)

From `files-to-upload/frontend/` into the Smoke frontend source tree (usually beside or under the API deploy, depending on how you build), then rebuild:

```bash
cd /path/to/smoke-frontend
# copy src files from package preserving paths
npm ci
npm run build
# publish dist/ per your usual cPanel/static deploy
```

Must include at least:

- `src/components/PendingDecisionCard.tsx` (live decision screenshot preview)
- `src/pages/RunDetailPage.tsx` (human-summary-first recommendations)

---

## Upload C — Worker (`worker.apis.aicountly.com`)

From `files-to-upload/worker/` into:

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

Preserve `portals/smoke/` paths. This package includes **reporter + reviewer deps** imported by `runSession.ts` (not nav-only).

| Local | Server |
|---|---|
| `portals/smoke/runSession.ts` | `portals/smoke/runSession.ts` |
| `portals/smoke/nav/*` | `portals/smoke/nav/*` |
| `portals/smoke/utils/dismissOverlays.ts` | `portals/smoke/utils/dismissOverlays.ts` |
| `portals/smoke/reporter/sessionReportBuilder.ts` | `portals/smoke/reporter/sessionReportBuilder.ts` |
| `portals/smoke/reporter/cursorPromptBuilder.ts` | `portals/smoke/reporter/cursorPromptBuilder.ts` |
| `portals/smoke/reporter/repoAttribution.ts` | `portals/smoke/reporter/repoAttribution.ts` **(new — imported by `cursorPromptBuilder.ts`; worker fails to boot without it)** |
| `portals/smoke/reporter/finalReportBuilder.ts` | `portals/smoke/reporter/finalReportBuilder.ts` |
| `portals/smoke/reviewer/uxReviewEngine.ts` | `portals/smoke/reviewer/uxReviewEngine.ts` |
| `portals/smoke/reviewer/featureGapEngine.ts` | `portals/smoke/reviewer/featureGapEngine.ts` |

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
# if the host compiles TS:
npm ci
npm run build   # or your usual transpile step
pm2 restart qa-worker --update-env
# or: pm2 restart global-worker --update-env
```

---

## Verify checklist (two hosts)

### Smoke API / UI

- [ ] Migrations `120000`–`120030` applied
- [ ] `GET /api/v1/runs/{id}/decisions` returns pending rows when worker pauses
- [ ] `GET /api/v1/runs/{id}/decisions/{decisionId}/screenshot` returns an image
- [ ] Run Detail pending card shows **live screenshot**, friendly situation label, recommended option
- [ ] UX / Gaps tabs show `human_summary` first; technical recommendation collapsed
- [ ] Session + final report HTML include **Decisions taken** with source (user / memory / timeout) and image when present
- [ ] Final report visual callouts show screenshot **or** explicit “unavailable” (no blank Target/Selector-only blocks without image handling)

### Worker

- [ ] Empty company list → job `awaiting_decision` → answer resumes same session
- [ ] Remembered second run inserts an **answered** decision row with source `memory` (no UI pause)
- [ ] Worker timeout marks decision `timed_out` (not silently `cancelled`)
- [ ] Killing worker during await: lease expiry times out pending decisions and requeues/fails (no eternal `awaiting_decision`)
- [ ] Worker log shows `Reused remembered choice: …` on memory hits

### Real-run scenario

1. Target profile with **zero companies**; start smoke run
2. Pending decision `company_picker_empty` with screenshot
3. Choose Create “Smoke Test Co”, remember=on
4. Session completes; report shows Decisions + visual evidence
5. Second run same product/env reuses memory; report/logs show reuse

---

## Rollback notes

- Worker-only rollback of the previous incomplete package is **not** sufficient if API migrations already ran.
- To disable mid-run pause behavior temporarily, stop/rollback worker `nav/askDecision` + `resolveAppContext` after API is stable; pending decisions can still be cancelled via run cancel.
