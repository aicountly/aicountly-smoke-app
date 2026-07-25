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

## Editing competitor benchmarks

Either edit the JSON files here and rerun the seeder:

```
php backend/spark db:seed CompetitorBenchmarksSeeder
```

Or edit at runtime from the *Competitor Benchmarks* page (recommended for
day-to-day usage).
