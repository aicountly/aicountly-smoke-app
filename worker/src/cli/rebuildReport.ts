/**
 * smoke:report -- --run-id=<id>
 *
 * Asks the backend to rebuild the consolidated final report from current DB
 * state. The numeric run id is shown on the runs list and on each run's
 * detail page; use it directly to avoid round-tripping through JWT-only
 * endpoints from the worker token.
 */
import { finalizeRun } from '../backend.js';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--run-id='));
  const id = arg ? Number(arg.split('=')[1]) : 0;
  if (!id) {
    console.error('Usage: smoke:report -- --run-id=<id>');
    process.exit(2);
  }
  await finalizeRun(id);
  console.log(`Rebuilt final report for run id=${id}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
