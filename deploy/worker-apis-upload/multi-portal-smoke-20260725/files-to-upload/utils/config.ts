import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv()

function int(key: string, def: number): number {
  const v = process.env[key]
  if (!v) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key]
  if (v === undefined) return def
  return v === '1' || v.toLowerCase() === 'true'
}

const workerId = process.env.QA_WORKER_ID || process.env.SMOKE_WORKER_ID || process.env.WORKER_ID || hostname()

const qaApiUrl = (process.env.QA_API_URL || '').replace(/\/$/, '')
const qaToken = process.env.QA_WORKER_TOKEN || ''
const smokeApiUrl = (process.env.SMOKE_API_URL || '').replace(/\/$/, '')
const smokeToken = process.env.SMOKE_WORKER_TOKEN || ''

export type PortalId = 'qa' | 'smoke'

const qaHeadless = bool('QA_HEADLESS', true)
const smokeHeadless =
  process.env.SMOKE_HEADLESS !== undefined ? bool('SMOKE_HEADLESS', true) : qaHeadless

export const config = {
  workerId,
  headless: qaHeadless,
  slowMo: int('QA_SLOWMO_MS', 0),
  pollIntervalMs: int('QA_POLL_INTERVAL_MS', 5000),
  heartbeatMs: int('QA_HEARTBEAT_MS', 15000),
  reportsDir: process.env.QA_REPORTS_DIR || '../qa-reports',

  /** @deprecated Prefer config.qa — kept so existing QA modules keep working. */
  apiUrl: qaApiUrl || 'http://localhost:8080/api',
  /** @deprecated Prefer config.qa */
  workerToken: qaToken,

  qa: {
    enabled: Boolean(qaApiUrl && qaToken),
    apiUrl: qaApiUrl || 'http://localhost:8080/api',
    workerToken: qaToken,
  },

  smoke: {
    enabled: Boolean(smokeApiUrl && smokeToken),
    apiUrl: smokeApiUrl,
    workerToken: smokeToken,
    leaseSeconds: int('SMOKE_LEASE_SECONDS', 600),
    pollIntervalMs: int('SMOKE_POLL_INTERVAL_MS', int('QA_POLL_INTERVAL_MS', 5000)),
    playwright: {
      headless: smokeHeadless,
      slowMo: process.env.SMOKE_SLOWMO_MS !== undefined ? int('SMOKE_SLOWMO_MS', 0) : int('QA_SLOWMO_MS', 0),
      browser: (process.env.SMOKE_BROWSER || process.env.PLAYWRIGHT_BROWSER || 'chromium') as
        | 'chromium'
        | 'firefox'
        | 'webkit',
      userAgent:
        process.env.SMOKE_USER_AGENT ||
        process.env.PLAYWRIGHT_USER_AGENT ||
        'AICountlySmokeBot/0.1 (+internal)',
    },
  },
}

export function enabledPortals(): PortalId[] {
  const portals: PortalId[] = []
  if (config.qa.enabled) portals.push('qa')
  if (config.smoke.enabled) portals.push('smoke')
  return portals
}

export function validateConfig(): string[] {
  const errs: string[] = []
  if (enabledPortals().length === 0) {
    errs.push(
      'Enable at least one portal: set QA_API_URL+QA_WORKER_TOKEN and/or SMOKE_API_URL+SMOKE_WORKER_TOKEN',
    )
  }
  if (qaApiUrl && !qaToken) errs.push('QA_WORKER_TOKEN is required when QA_API_URL is set')
  if (qaToken && !qaApiUrl) errs.push('QA_API_URL is required when QA_WORKER_TOKEN is set')
  if (smokeApiUrl && !smokeToken) errs.push('SMOKE_WORKER_TOKEN is required when SMOKE_API_URL is set')
  if (smokeToken && !smokeApiUrl) errs.push('SMOKE_API_URL is required when SMOKE_WORKER_TOKEN is set')
  return errs
}
