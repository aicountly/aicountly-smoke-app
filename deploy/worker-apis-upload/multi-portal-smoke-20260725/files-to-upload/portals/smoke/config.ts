/**
 * Smoke portal settings for modules under portals/smoke/.
 * Reads from the shared worker config (one .env at worker root).
 */
import path from 'node:path'
import { config as root } from '../../utils/config.js'

const repoRoot = path.resolve(process.cwd())

export const config = {
  repoRoot,
  backendUrl: root.smoke.apiUrl,
  workerToken: root.smoke.workerToken,
  workerId: root.workerId,
  pollIntervalMs: root.smoke.pollIntervalMs,
  leaseSeconds: root.smoke.leaseSeconds,
  reportsDir: path.resolve(repoRoot, 'tmp-smoke-scratch'),
  playwright: root.smoke.playwright,
}

export function validateConfig(): string[] {
  const errs: string[] = []
  if (!root.smoke.enabled) {
    errs.push('Smoke portal is not enabled (set SMOKE_API_URL and SMOKE_WORKER_TOKEN)')
  }
  return errs
}
