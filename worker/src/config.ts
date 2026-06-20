import 'dotenv/config';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), process.env.SMOKE_ROOT_RELATIVE ?? '..');

export const config = {
  repoRoot,
  backendUrl: (process.env.WORKER_BACKEND_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, ''),
  workerToken: process.env.WORKER_SHARED_TOKEN ?? '',
  workerId: `worker-${process.pid}-${Date.now().toString(36)}`,
  pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2500),
  leaseSeconds: Number(process.env.WORKER_LEASE_SECONDS ?? 600),
  reportsDir: process.env.REPORTS_DIR
    ? path.isAbsolute(process.env.REPORTS_DIR)
      ? process.env.REPORTS_DIR
      : path.resolve(repoRoot, process.env.REPORTS_DIR)
    : path.resolve(repoRoot, 'smoke-reports'),
  playwright: {
    headless: (process.env.PLAYWRIGHT_HEADLESS ?? 'true').toLowerCase() !== 'false',
    slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0),
    browser: (process.env.PLAYWRIGHT_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit',
    userAgent: process.env.PLAYWRIGHT_USER_AGENT ?? 'AICountlySmokeBot/0.1 (+internal)',
  },
};

if (!config.workerToken) {
  console.warn('[smoke-worker] WORKER_SHARED_TOKEN is not set; backend calls will fail.');
}
