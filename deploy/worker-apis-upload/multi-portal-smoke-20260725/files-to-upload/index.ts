#!/usr/bin/env node
/**
 * AICOUNTLY shared Playwright worker (worker.apis.aicountly.com).
 *
 * One install / one PM2 process. Portals are selected by .env:
 *   QA    — QA_API_URL + QA_WORKER_TOKEN
 *   Smoke — SMOKE_API_URL + SMOKE_WORKER_TOKEN
 *
 * Modes (set via --mode=<name> or npm run qa:<mode>):
 *   default        Poll enabled portal APIs, run one job at a time, repeat.
 *   basic-check    QA only: production-safe login + nav (no dummy data).
 *   run-session    Claim and run exactly one job (QA first, then Smoke), then exit.
 *   smoke-session  Claim and run exactly one Smoke job, then exit.
 *   books          QA poll loop (books product preference logged).
 *   reports        Rebuild consolidated QA report under --run-dir=...
 *   validate       TBD (inline in run-session today).
 *   cleanup        QA cleanup mode notes.
 *
 * Always runs ONE session/job at a time. Never parallel.
 */

import { fetchNextSession, pingWorker } from './apiClient.js'
import { runOneSession } from './runner/sessionRunner.js'
import { buildFinalReport } from './reporter/finalReportBuilder.js'
import { config, enabledPortals, validateConfig, type PortalId } from './utils/config.js'
import { leaseNextJob } from './portals/smoke/backend.js'
import { runSmokeJob } from './portals/smoke/runJob.js'

type Mode =
  | 'default'
  | 'basic-check'
  | 'run-session'
  | 'smoke-session'
  | 'books'
  | 'reports'
  | 'validate'
  | 'cleanup'

function parseArgs(): { mode: Mode; runDir?: string; qaRunId?: string } {
  const args = process.argv.slice(2)
  let mode: Mode = 'default'
  let runDir: string | undefined
  let qaRunId: string | undefined
  for (const a of args) {
    if (a.startsWith('--mode=')) mode = a.slice(7) as Mode
    if (a.startsWith('--run-dir=')) runDir = a.slice(10)
    if (a.startsWith('--qa-run-id=')) qaRunId = a.slice(12)
  }
  return { mode, runDir, qaRunId }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Round-robin portal order so neither portal starves. */
function portalOrder(start: number): PortalId[] {
  const portals = enabledPortals()
  if (portals.length <= 1) return portals
  const out: PortalId[] = []
  for (let i = 0; i < portals.length; i++) {
    out.push(portals[(start + i) % portals.length]!)
  }
  return out
}

async function tryClaimQa(): Promise<boolean> {
  if (!config.qa.enabled) return false
  await pingWorker().catch(() => {})
  const p = await fetchNextSession()
  if (!p.session) return false
  console.log(`[worker:qa] claimed session #${p.session.id}: ${p.session.name}`)
  await runOneSession(p)
  console.log(`[worker:qa] finished session #${p.session.id}`)
  return true
}

async function tryClaimSmoke(): Promise<boolean> {
  if (!config.smoke.enabled) return false
  const job = await leaseNextJob()
  if (!job) return false
  console.log(
    `[worker:smoke] leased job=${job.job_id} session=${job.session.id} run=${job.run_code}`,
  )
  await runSmokeJob(job)
  return true
}

async function claimAndRunOnce(order: PortalId[]): Promise<boolean> {
  for (const portal of order) {
    try {
      if (portal === 'qa') {
        if (await tryClaimQa()) return true
      } else if (portal === 'smoke') {
        if (await tryClaimSmoke()) return true
      }
    } catch (err) {
      console.error(`[worker:${portal}] claim/run error:`, (err as Error)?.message ?? err)
    }
  }
  return false
}

async function pollLoop(mode: 'default' | 'books'): Promise<void> {
  const portals = enabledPortals()
  console.log(`[worker] entering poll loop for portals=[${portals.join(', ')}]. Ctrl+C to stop.`)
  let rotate = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const order = portalOrder(rotate)
      rotate = (rotate + 1) % Math.max(1, portals.length)
      const ran = await claimAndRunOnce(order)
      if (!ran) {
        await sleep(config.pollIntervalMs)
      } else if (mode === 'books') {
        // books mode is QA-oriented; after a job, continue looping
      }
    } catch (err) {
      console.error('[worker] loop error:', (err as Error)?.message)
      await sleep(config.pollIntervalMs)
    }
  }
}

async function main(): Promise<void> {
  const { mode, runDir } = parseArgs()
  const portals = enabledPortals()
  console.log(
    `[worker] starting mode=${mode} workerId=${config.workerId} portals=[${portals.join(', ') || 'none'}]`,
  )
  if (config.qa.enabled) console.log(`[worker] qa api=${config.qa.apiUrl}`)
  if (config.smoke.enabled) console.log(`[worker] smoke api=${config.smoke.apiUrl}`)

  const cfgErrs = validateConfig()
  if (mode !== 'reports' && cfgErrs.length) {
    console.error('[worker] config errors:', cfgErrs.join(', '))
    process.exit(1)
  }

  switch (mode) {
    case 'reports': {
      if (!runDir) {
        console.error('[worker] --run-dir=<path-to-qa-reports/product/date/qa_run_id> required.')
        process.exit(2)
      }
      const out = await buildFinalReport(runDir)
      console.log('[worker] consolidated report written:', out.htmlPath, out.jsonPath)
      return
    }
    case 'validate': {
      console.log(
        '[worker] validate mode reads existing report.json files locally and re-runs validation engines — TBD; in this release validations run inline in run-session.',
      )
      return
    }
    case 'cleanup': {
      console.log(
        '[worker] cleanup mode is intentionally a no-op on production targets and only deletes rows tagged with the given qa_run_id via the target UI.',
      )
      console.log(
        '[worker] cleanup details are emitted into the run report. Refuses to run when target.environment in (prod_basic, prod_full).',
      )
      return
    }
    case 'smoke-session': {
      if (!config.smoke.enabled) {
        console.error('[worker] Smoke portal not configured.')
        process.exit(1)
      }
      const ran = await tryClaimSmoke()
      if (!ran) console.log('[worker:smoke] no jobs queued.')
      return
    }
    case 'run-session': {
      const ran = await claimAndRunOnce(portalOrder(0))
      if (!ran) console.log('[worker] no sessions/jobs queued on any enabled portal.')
      return
    }
    case 'basic-check': {
      if (!config.qa.enabled) {
        console.error('[worker] QA portal not configured (basic-check is QA-only).')
        process.exit(1)
      }
      const p = await fetchNextSession()
      if (!p.session) {
        console.log('[worker] no sessions queued.')
        return
      }
      console.log(`[worker:qa] running basic-check for session #${p.session.id}`)
      await runOneSession(p, { basicCheck: true })
      console.log('[worker:qa] basic-check complete.')
      return
    }
    case 'books':
    case 'default': {
      await pollLoop(mode)
      return
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[worker] SIGINT received — shutting down.')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n[worker] SIGTERM received — shutting down.')
  process.exit(0)
})

main().catch((err) => {
  console.error('[worker] fatal:', err)
  process.exit(1)
})
