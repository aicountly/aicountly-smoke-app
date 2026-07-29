# Upload via cPanel File Manager (no SSH)

**Zip on your PC:**

`C:\Users\pc\aicountly-smoke-app\deploy\worker-apis-upload\multi-portal-smoke-20260725.zip`

**Target on server:**

`/home/apisaicountly/public_html/worker.apis.aicountly.com/`

## Steps

1. Log into **cPanel** for user **apisaicountly**.
2. Open **File Manager**.
3. Go to: `public_html/worker.apis.aicountly.com/`
4. **Do not delete** existing `.env` (keeps QA token).
5. Upload `multi-portal-smoke-20260725.zip` into that folder.
6. Right-click the zip → **Extract**.
7. Open the extracted folder `multi-portal-smoke-20260725/files-to-upload/`.
8. Select **all contents** inside `files-to-upload` (`index.ts`, `utils/`, `portals/`, etc.).
9. **Move / copy** them up into `worker.apis.aicountly.com/` so paths become:
   - `worker.apis.aicountly.com/index.ts` (overwrite)
   - `worker.apis.aicountly.com/utils/config.ts` (overwrite)
   - `worker.apis.aicountly.com/portals/smoke/...` (new)
   - `worker.apis.aicountly.com/package.json` (overwrite)
   - `worker.apis.aicountly.com/.env.example` (overwrite example only — **not** `.env`)
10. Edit **existing** `.env` in File Manager (Edit). **Add** these lines at the bottom (use Smoke’s current token from smoke `api/.env` — do **not** regenerate):

```env
# Smoke portal (shared worker)
SMOKE_API_URL=https://smoke.aicountly.org/api/v1
SMOKE_WORKER_TOKEN=PASTE_SAME_AS_SMOKE_API_WORKER_SHARED_TOKEN
SMOKE_LEASE_SECONDS=600
```

Leave all existing `QA_*` lines unchanged.

11. Restart the worker from cPanel **Setup Node.js App** / **Terminal** / whatever you used before for PM2.  
    If you only have File Manager and no terminal, use the same method QA used last time to restart `aicountly-qa-worker` / `qa-worker`.

    Typical (only if you have Terminal in cPanel):

```bash
cd ~/public_html/worker.apis.aicountly.com
npm install
pm2 restart aicountly-qa-worker || pm2 restart qa-worker
pm2 logs aicountly-qa-worker --lines 30
```

12. Confirm logs show: `portals=[qa, smoke]` (or at least smoke if QA vars temporarily missing — they should still be present).

## Safety

- Overwriting `index.ts` / `utils/config.ts` does **not** remove QA.
- Smoke is **off** until `SMOKE_API_URL` + `SMOKE_WORKER_TOKEN` are set.
- Never replace or delete production `.env`.
