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

The production worker on cPanel is PM2 process `aicountly-smoke-worker`, defined by
[`worker/ecosystem.config.cjs`](../worker/ecosystem.config.cjs) and restarted by the
deploy workflow. Start it only via `pm2 startOrRestart ecosystem.config.cjs`: a
second, differently named process would double-lease the job queue.

Each maps to a `npm --workspace worker` command. See
[`worker/README.md`](../worker/README.md) and [`worker/src/cli/`](../worker/src/cli/).
