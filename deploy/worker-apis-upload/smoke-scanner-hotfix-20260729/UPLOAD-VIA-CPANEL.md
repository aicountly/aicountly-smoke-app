# Smoke scanner `__name` hotfix (2026-07-29)

## Symptom

Login works (`Login successful — now at https://books.aicountly.com/...`) then:

```
page.evaluate: ReferenceError: __name is not defined
at scanMenus (.../menuScanner.ts:15)
```

Cause: `tsx`/esbuild injects `__name()` into function-form `page.evaluate` callbacks; the browser has no `__name`.

## Upload these 4 files

Into `/home/apisaicountly/public_html/worker.apis.aicountly.com/`:

| Local | Server |
|---|---|
| `portals/smoke/scanner/menuScanner.ts` | `portals/smoke/scanner/menuScanner.ts` |
| `portals/smoke/scanner/pageScanner.ts` | `portals/smoke/scanner/pageScanner.ts` |
| `portals/smoke/scanner/uiInventory.ts` | `portals/smoke/scanner/uiInventory.ts` |
| `portals/smoke/runSession.ts` | `portals/smoke/runSession.ts` |

## Restart

```bash
cd /home/apisaicountly/public_html/worker.apis.aicountly.com
grep -n "SCAN_MENUS_JS\|addInitScript" portals/smoke/scanner/menuScanner.ts portals/smoke/runSession.ts | head
pm2 restart qa-worker --update-env
```

## Confirm

Re-run Login + Dashboard. Expect menu scan to continue past landing screenshot — no `__name is not defined`.
