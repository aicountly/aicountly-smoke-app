import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function int(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

const repoRoot = path.resolve(process.cwd(), process.env.SMOKE_ROOT_RELATIVE ?? '..');

export const config = {
  repoRoot,
  backendUrl: (process.env.WORKER_BACKEND_URL ?? 'http://localhost:8080/api/v1').replace(/\/$/, ''),
  workerToken: process.env.WORKER_SHARED_TOKEN ?? '',
  workerId: process.env.WORKER_ID || hostname(),
  pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 2500),
  leaseSeconds: int('WORKER_LEASE_SECONDS', 600),
  maxScreensPerSession: Math.max(1, int('SMOKE_MAX_SCREENS_PER_SESSION', 150)),
  /** Hard upper bound a session's own `max_steps` override may not exceed, regardless of who set it. */
  maxStepsCeiling: Math.max(1, int('SMOKE_MAX_STEPS_CEILING', 300)),
  stepScreenshotRetention: Math.max(1, int('SMOKE_STEP_SCREENSHOT_RETENTION', 300)),
  /**
   * Decide mid-run situations from the brain's recommendation instead of parking
   * the job and waiting for an operator. Set SMOKE_AUTONOMOUS=false to go back to
   * asking a human for every unexpected screen.
   */
  autonomous: bool('SMOKE_AUTONOMOUS', true),
  reportsDir: process.env.REPORTS_DIR
    ? path.isAbsolute(process.env.REPORTS_DIR)
      ? process.env.REPORTS_DIR
      : path.resolve(repoRoot, process.env.REPORTS_DIR)
    : path.resolve(repoRoot, 'smoke-reports'),
  playwright: {
    headless: bool('PLAYWRIGHT_HEADLESS', true),
    slowMo: int('PLAYWRIGHT_SLOW_MO', 0),
    browser: (process.env.PLAYWRIGHT_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit',
    userAgent: process.env.PLAYWRIGHT_USER_AGENT ?? 'AICountlySmokeBot/0.1 (+internal)',
  },
};

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.workerToken) errs.push('WORKER_SHARED_TOKEN is required (copy worker/.env.example to worker/.env)');
  if (!config.backendUrl) errs.push('WORKER_BACKEND_URL is required');
  return errs;
}
