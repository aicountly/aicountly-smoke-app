# Smoke plan-generation speed hotfix (2026-07-29)

## Symptom

New Observation stuck on **Generating plan...**. Network/XHR often empties after ~60s because the browser aborted while the API was still running OpenAI → Perplexity → Gemini **one after another**.

## Fix

Plan generation now uses a **single planner LLM** (OpenAI, then Gemini fallback). Full council mode remains available via settings.

## Upload — smoke API

Copy from `files-to-upload/smoke-api/` into the smoke API app root (CodeIgniter `app/`):

| Local file | Server path |
|---|---|
| `app/Services/Brain/BrainEnsemble.php` | `app/Services/Brain/BrainEnsemble.php` |
| `app/Services/Brain/Adapters/AbstractAdapter.php` | `app/Services/Brain/Adapters/AbstractAdapter.php` |
| `app/Services/Brain/Adapters/OpenAIAdapter.php` | `app/Services/Brain/Adapters/OpenAIAdapter.php` |
| `app/Services/Brain/Adapters/GeminiAdapter.php` | `app/Services/Brain/Adapters/GeminiAdapter.php` |
| `app/Services/Brain/Adapters/PerplexityAdapter.php` | `app/Services/Brain/Adapters/PerplexityAdapter.php` |
| `app/Controllers/MasterPromptsController.php` | `app/Controllers/MasterPromptsController.php` |

No worker / PM2 restart needed for PHP (opcache: clear or wait).

## Upload — frontend

Rebuild/redeploy the SPA with the updated `NewObservationPage.tsx`, **or** merge that file into your frontend source and rebuild:

```bash
cd frontend && npm run build
```

Deploy the built assets to the smoke portal host.

## Optional settings

Insert into `smoke_settings` if you want them visible in admin (defaults already apply in code):

```sql
INSERT INTO smoke_settings (key, value_json, description, is_secret)
VALUES
  ('brain.plan_mode', '"fast"', 'fast | council', false),
  ('brain.plan_providers', '["openai","gemini"]', 'Ordered planners for fast mode', false)
ON CONFLICT DO NOTHING;
```

To restore the slow full council for planning:

```sql
UPDATE smoke_settings SET value_json = '"council"' WHERE key = 'brain.plan_mode';
```
