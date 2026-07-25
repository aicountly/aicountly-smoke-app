/**
 * smoke:books / smoke:hrms (and friends).
 *
 *   npm run smoke:books            -- enqueue latest approved books plan
 *   npm run smoke:hrms             -- ...
 *   npm run smoke:books -- --plan-id=12
 *
 * Uses the worker shared token against POST /worker/enqueue.
 */
import { backend } from '../backend.js';

async function main(): Promise<void> {
  const productArg = process.argv.find((a) => a.startsWith('--product='));
  const planArg = process.argv.find((a) => a.startsWith('--plan-id='));
  const product = productArg ? productArg.split('=')[1] : 'books';
  const planId = planArg ? Number(planArg.split('=')[1]) : 0;

  const payload: Record<string, unknown> = planId > 0 ? { plan_id: planId } : { product };
  console.log(`[enqueue] Requesting run via /worker/enqueue`, payload);

  const r = await backend.post<{ data: { id: number; run_code: string } }>('/worker/enqueue', payload);
  const run = r.data.data;
  console.log(`[enqueue] Started run id=${run.id} code=${run.run_code}`);
  console.log(`[enqueue] Ensure the Playwright worker is polling to process jobs.`);
}

main().catch((e) => {
  const ax = e as { response?: { data?: { message?: string; error?: string }; status?: number }; message?: string };
  const msg = ax.response?.data?.message ?? ax.response?.data?.error ?? ax.message ?? String(e);
  console.error(`[enqueue] Failed (${ax.response?.status ?? '?'}): ${msg}`);
  process.exit(1);
});
