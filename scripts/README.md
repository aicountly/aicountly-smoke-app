# scripts/

Top-level convenience scripts. Wired through the root `package.json` so you can
invoke them from anywhere in the repo:

```
npm run smoke:observe          # dev poll loop (tsx, no build)
npm run smoke:run-session -- --session=42
npm run smoke:books
npm run smoke:hrms
npm run smoke:report -- --run-id=17
```

Production worker on cPanel uses `worker/scripts/start-worker.sh` or
`pm2 start npm --name smoke-worker -- start` (runs compiled `dist/index.js`).

Each maps to a `npm --workspace worker` command. See
[`worker/README.md`](../worker/README.md) and [`worker/src/cli/`](../worker/src/cli/).
