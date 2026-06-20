# scripts/

Top-level convenience scripts. Wired through the root `package.json` so you can
invoke them from anywhere in the repo:

```
npm run smoke:observe
npm run smoke:run-session -- --session=42
npm run smoke:books
npm run smoke:hrms
npm run smoke:report -- --run-id=17
```

Each maps to a `npm --workspace worker` command. See
[`worker/src/cli/`](../worker/src/cli/) for the actual entry points.
