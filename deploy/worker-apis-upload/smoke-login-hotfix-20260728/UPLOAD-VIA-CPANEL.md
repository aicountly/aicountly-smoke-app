# Smoke login + Jump To hotfix (2026-07-28)

## Why Sales / Invoices only shows the login screenshot

Two problems stacked:

1. **Live worker is still old code.** Logs that say `Login successful - scanning landing page` and `Found 0 menu item(s)` prove that. Until this package is uploaded and PM2 restarted, sessions never leave `/login`.
2. **AICountly requires "Jump To".** The login form has a required **Jump To** product dropdown (Smart Books / ERP / Contacts / …). Skipping it shows a red error: **Error! Please choose jump to.** — so you never reach the Sales / Invoices dashboard.

This package selects **Jump To → Smart Books** (or `SMOKE_JUMP_TO` / ERP / Books), then completes email → password login, then screenshots landing + menus.

## Upload these 4 files

From this package `files-to-upload/` into:

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

| Local file | Server path |
|---|---|
| `portals/smoke/auth/login.ts` | `portals/smoke/auth/login.ts` |
| `portals/smoke/runSession.ts` | `portals/smoke/runSession.ts` |
| `portals/smoke/scanner/menuScanner.ts` | `portals/smoke/scanner/menuScanner.ts` |
| `portals/smoke/utils/safeActionGuard.ts` | `portals/smoke/utils/safeActionGuard.ts` |

Do **not** replace `.env`.

Optional in worker `.env` if Smart Books is wrong for your tenant:

```bash
SMOKE_JUMP_TO=Smart Books
```

## Restart worker

```bash
cd ~/public_html/worker.apis.aicountly.com
pm2 restart aicountly-qa-worker || pm2 restart qa-worker || pm2 restart smoke-worker
pm2 logs --lines 40
```

## Confirm it worked

Re-run **Sales / Invoices** (or Login + Dashboard). New logs must look like:

- `Action screenshot: login form at ...`
- `Login successful — now at https://my.aicountly.com/...` (NOT still `/login`)
- `Action screenshot: landing page ...`
- More than `1 screenshot(s)` in View log
- Menu discovery > 0 items (or direct-nav attempts)

If you still see `Login successful - scanning landing page`, the old file is still running (wrong path or PM2 not restarted).

## Credentials / OTP / Jump To

Target profile username + password must work. AICountly also requires **Jump To** (e.g. Smart Books) — the hotfix selects it automatically (or set `SMOKE_JUMP_TO=Smart Books` in worker `.env`).

If AICountly asks for OTP/2FA, smoke cannot finish login — use a sandbox password-only account.
