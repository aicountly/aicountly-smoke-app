# Sample data

Used both as bootstrap seed data (competitors are loaded by
`CompetitorBenchmarksSeeder`) and as deterministic-fallback inputs when the
brain has no provider configured.

## Folders

- `prompts/` &mdash; example master prompts for the *New Observation* form.
  Listed via `GET /api/v1/master-prompt-samples` (metadata in `manifest.json`,
  text in `*.txt`). Edit these files on the server and redeploy `samples/` to
  update the dropdown without rebuilding the frontend.
- `sessions/` &mdash; per-product fallback session plans used by the
  `DeterministicAdapter` when no AI provider is configured.
- `competitors/` &mdash; per-product competitor feature lists. Loaded into
  `smoke_competitor_profiles` by the seeder. Edit at runtime via the
  *Competitor Benchmarks* page.
- `reports/` &mdash; HTML templates rendered by `SessionReportBuilder` and
  `FinalReportBuilder` for every run. Mustache-flavoured (`{{var}}`,
  `{{#section}}...{{/section}}`).
- `fixtures/` &mdash; synthetic, non-sensitive files and `manifest.json`
  scenarios for all SaaS products. The worker copies each fixture into the
  run report directory before use; never edit a fixture in place during a run.

## File I/O fixture safety

Fixtures may be uploaded/imported only to `sandbox` or `gh_staging` when the
profile enables safe demo, the session enables destructive actions, the exact
file action is allowed, and the operator approves the first upload for that
product/module. Production file mutations are always blocked. Downloads and
exports are compared by hash, MIME, size, and format structure, then optionally
reviewed by the `file_quality` brain task.

## Editing competitor benchmarks

Either edit the JSON files here and rerun the seeder:

```
php backend/spark db:seed CompetitorBenchmarksSeeder
```

Or edit at runtime from the *Competitor Benchmarks* page (recommended for
day-to-day usage).
