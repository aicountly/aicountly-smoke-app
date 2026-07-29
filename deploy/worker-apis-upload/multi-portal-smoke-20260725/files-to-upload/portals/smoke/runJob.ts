/**
 * Run one leased Smoke observation job (heartbeat + complete/fail).
 */
import { appendLog, complete, fail, heartbeat, type Job } from './backend.js'
import { config } from './config.js'
import { runSession } from './runSession.js'

export async function runSmokeJob(job: Job): Promise<void> {
  const hbHandle = setInterval(() => {
    heartbeat(job.job_id).catch((e) =>
      console.warn('[worker:smoke] heartbeat failed:', (e as Error)?.message),
    )
  }, Math.max(30_000, (config.leaseSeconds * 1000) / 3))

  try {
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Starting session "${job.session.name}" for run ${job.run_code}`,
    }).catch(() => {})

    const result = await runSession(job)
    await complete(job.job_id, result)
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Finished session "${job.session.name}" — ${String(result.screens_observed ?? 0)} screens observed`,
    }).catch(() => {})
    console.log(`[worker:smoke] Completed job=${job.job_id}`)
  } catch (e) {
    const msg = (e as Error).stack ?? (e as Error).message ?? String(e)
    console.error('[worker:smoke] Job failed:', msg)
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'error',
      message: `Session failed: ${msg.slice(0, 500)}`,
    }).catch(() => {})
    try {
      await fail(job.job_id, msg.slice(0, 4000))
    } catch (e2) {
      console.error('[worker:smoke] fail() failed:', (e2 as Error).message)
    }
  } finally {
    clearInterval(hbHandle)
  }
}
