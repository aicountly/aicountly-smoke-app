# Smoke login Jump To hotfix (2026-07-29)

## What your logs mean

```
locator.click: Timeout … waiting for locator('input[type="password"]:visible')
at fillReactInput (…/login.ts:130)
at aicountlyLogin (…/login.ts:60)
```

Those line numbers are the **old** login.ts (before Jump To). The worker signed in with email only, AICountly returned **Error! Please choose Jump To.**, the password field never appeared, then Playwright timed out clicking it.

Uploading `.env` / API keys does **not** fix this. Env is already working (the worker leased the job). This is stale login code on the server.

## Upload these 4 files

From this package `files-to-upload/` into:

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

| Local file | Server path |
|---|---|
| `portals/smoke/auth/login.ts` | `portals/smoke/auth/login.ts` |
| `portals/smoke/runSession.ts` | `portals/smoke/runSession.ts` |
| `portals/smoke/scanner/menuScanner.ts` | `portals/smoke/scanner/menuScanner.ts` |
| `portals/smoke/utils/safeActionGuard.ts` | `portals/smoke/utils/safeActionGuard.ts` |

Do **not** replace `.env` unless you are fixing tokens. Keep existing `WORKER_SHARED_TOKEN` / backend URL.

Optional in worker `.env`:

```bash
SMOKE_JUMP_TO=Smart Books
```

## Restart worker (required)

File upload alone is not enough — PM2 keeps the old process in memory.

```bash
cd ~/public_html/worker.apis.aicountly.com
pm2 restart aicountly-qa-worker || pm2 restart qa-worker || pm2 restart smoke-worker
pm2 logs --lines 40
```

## Confirm it worked

Re-run **Login + Dashboard**. New logs should look like:

- `Action screenshot: login form at ...`
- `Login successful — now at https://my.aicountly.com/...` (NOT still `/login`)
- Not the old stack at `login.ts:130` / `login.ts:60`

If you still see `fillReactInput (...:130)`, the old file is still running (wrong path or PM2 not restarted).

## Credentials / OTP

Target profile username + **stored password** (portal credential vault, not `.env` API keys) must be a real AICountly user.

If AICountly asks for OTP/2FA, smoke cannot finish login — use a sandbox password-only account.
