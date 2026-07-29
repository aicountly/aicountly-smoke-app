# QA review — shared worker multi-portal (Smoke add-on)

Please inspect before/after upload. Goal: **QA must keep working**; Smoke is an optional second portal on the **same** worker path.

## What this package is

Manual upload for:

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

Not a second worker. Not `smoke-worker/`. Not a `/qa` or `/smoke` sub-app.

## Files QA should inspect

### Overwrites (behavior-sensitive)

| File | Change | QA impact |
|------|--------|-----------|
| `index.ts` | Poll loop can also lease Smoke jobs | QA still uses `fetchNextSession` + `runOneSession` unchanged |
| `utils/config.ts` | Adds optional `smoke` block; keeps `QA_*` | If only `QA_*` set, Smoke stays disabled; QA-only mode works |
| `package.json` | Adds `smoke:run-session` script | No runtime change for `npm start` |

### New (Smoke-only; unused unless Smoke env set)

| Path | Purpose |
|------|---------|
| `portals/smoke/**` | Smoke API client + observation runner |

### Docs / example only

| File | Notes |
|------|-------|
| `.env.example` | Documents `SMOKE_*`; does **not** change live `.env` |
| `README.md` | Updated architecture notes |

## Files NOT touched (QA path intact)

These are **not** in the zip and remain as on the server:

- `apiClient.ts` (QA `X-Worker-Token`, next-session, evidence upload, progress)
- `runner/sessionRunner.ts` and all QA runner/step code
- `auth/`, `capture/`, `validation/`, `context/`, `data/`
- `reporter/*` (QA reporters)
- `types.ts`
- Live `.env` (must keep existing `QA_API_URL` / `QA_WORKER_TOKEN`)

## How QA stays safe

1. **Default without Smoke env:** same as today — only QA polls if only `QA_*` is configured.
2. **With Smoke env added:** one job at a time, round-robin between portals. QA sessions still claimed via existing QA API.
3. **No parallel browsers** — still single-session execution.
4. **No change to QA evidence upload** or Live Log APIs.

## Suggested QA smoke-test after upload

1. Keep `.env` `QA_*` exactly as before; add `SMOKE_*` only after QA check if preferred.
2. Restart worker.
3. Queue a small QA login session → confirm Live Log + screenshots still work.
4. Then add Smoke token lines and confirm Smoke run leases without breaking QA.

## Manifest

See `MANIFEST.txt` for every path included under `files-to-upload/`.
