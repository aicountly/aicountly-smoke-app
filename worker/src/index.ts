import { config, validateConfig } from './config.js';
import { appendLog, complete, fail, heartbeat, leaseNextJob, type Job } from './backend.js';
import { runSession } from './runSession.js';

let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('[smoke-worker] SIGINT received, draining...'); });
process.on('SIGTERM', () => { stopping = true; console.log('[smoke-worker] SIGTERM received, draining...'); });

async function main(): Promise<void> {
  const configErrors = validateConfig();
  if (configErrors.length) {
    for (const err of configErrors) console.error(`[smoke-worker] ${err}`);
    process.exit(1);
  }

  console.log(`[smoke-worker] Starting. id=${config.workerId} backend=${config.backendUrl}`);
  while (!stopping) {
    try {
      const job = await leaseNextJob();
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      console.log(`[smoke-worker] Leased job=${job.job_id} session=${job.session.id} run=${job.run_code}`);
      await appendLog({
        run_id: job.run_id,
        session_id: job.session.id,
        job_id: job.job_id,
        message: `Starting session "${job.session.name}" for run ${job.run_code}`,
      }).catch(() => {});
      await runOne(job);
    } catch (e) {
      console.error('[smoke-worker] Lease loop error:', (e as Error).message);
      await sleep(config.pollIntervalMs * 4);
    }
  }
  console.log('[smoke-worker] Exited gracefully.');
}

async function runOne(job: Job): Promise<void> {
  const hbHandle = setInterval(() => {
    heartbeat(job.job_id).catch((e) => console.warn('[smoke-worker] heartbeat failed:', e?.message));
  }, Math.max(30_000, (config.leaseSeconds * 1000) / 3));

  try {
    const result = await runSession(job);
    await complete(job.job_id, result);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      message: `Finished session "${job.session.name}" — ${String(result.screens_observed ?? 0)} screens observed`,
    }).catch(() => {});
    console.log(`[smoke-worker] Completed job=${job.job_id}`);
  } catch (e) {
    const msg = (e as Error).stack ?? (e as Error).message ?? String(e);
    console.error('[smoke-worker] Job failed:', msg);
    await appendLog({
      run_id: job.run_id,
      session_id: job.session.id,
      job_id: job.job_id,
      level: 'error',
      message: `Session failed: ${msg.slice(0, 500)}`,
    }).catch(() => {});
    try { await fail(job.job_id, msg.slice(0, 4000)); }
    catch (e2) { console.error('[smoke-worker] fail() failed:', (e2 as Error).message); }
  } finally {
    clearInterval(hbHandle);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

main().catch((e) => { console.error(e); process.exit(1); });
