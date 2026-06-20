/**
 * smoke:run-session
 *
 *   npm run smoke:run-session -- --session=<sid>
 *
 * Convenience: pulls a single session via the worker lease loop
 * regardless of ordinal. Useful for debugging an individual session.
 *
 * Note: the canonical execution path is `smoke:observe`. This CLI assumes the
 * given session has an enqueued, queued job ready to lease (e.g. the run was
 * started but other workers have not yet picked it up).
 */
import { complete, fail, leaseNextJob } from '../backend.js';
import { runSession } from '../runSession.js';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--session='));
  const sid = arg ? Number(arg.split('=')[1]) : 0;
  if (!sid) {
    console.error('Usage: smoke:run-session -- --session=<id>');
    process.exit(2);
  }

  let attempts = 0;
  while (attempts++ < 10) {
    const job = await leaseNextJob();
    if (!job) {
      console.error('No queued jobs available.');
      process.exit(0);
    }
    if (job.session.id !== sid) {
      // not our target -- release by failing with retry hint
      await fail(job.job_id, `requested session ${sid}, leased ${job.session.id}; releasing for queue.`);
      continue;
    }
    try {
      const r = await runSession(job);
      await complete(job.job_id, r);
      console.log(JSON.stringify(r, null, 2));
      return;
    } catch (e) {
      await fail(job.job_id, (e as Error).message);
      throw e;
    }
  }
  console.error('Could not locate the requested session in the queue.');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
