// PM2 definition for the smoke Playwright worker on the smoke.aicountly.org
// cPanel account (${PROD_REMOTE_ROOT}/worker).
//
// The deploy workflow runs, from this directory:
//   pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save
//
// Secrets stay in worker/.env on the server (never committed, never deployed);
// nothing in this file may contain a token.
//
// Must stay .cjs: the worker package is "type": "module" and PM2 loads config
// files as CommonJS.

const path = require('node:path');

const workerDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'aicountly-smoke-worker',

      // Runs `npm start` → node dist/index.js (compiled output, not tsx).
      script: 'npm',
      args: 'start',
      exec_mode: 'fork',

      // Resolved from this file, so `pm2 startOrRestart <path>/ecosystem.config.cjs`
      // behaves identically no matter which directory pm2 was invoked from.
      cwd: workerDir,

      // Never more than one: this worker leases jobs from smoke_session_jobs, and
      // a second instance would double-lease the queue and interleave sessions.
      instances: 1,

      autorestart: true,

      // Node-side ceiling only (headless Chromium runs as a separate process and
      // is not counted here). High enough to survive screenshot/HTML buffers for a
      // long session, low enough to reap a leak before the account memory limit.
      max_memory_restart: '1G',

      time: true,
      merge_logs: true,
      out_file: path.join(workerDir, 'logs', 'worker-out.log'),
      error_file: path.join(workerDir, 'logs', 'worker-error.log'),
    },
  ],
};
