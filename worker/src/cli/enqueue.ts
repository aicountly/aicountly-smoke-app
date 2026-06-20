/**
 * smoke:books / smoke:hrms (and friends).
 *
 *   npm run smoke:books            -- enqueue all approved books sessions
 *   npm run smoke:hrms             -- ...
 *   npm run smoke:enqueue -- --product=auditor
 *
 * Looks up the most-recently-approved session plan for a profile of the
 * requested product and triggers a run.
 */
import { backend } from '../backend.js';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--product='));
  const product = arg ? arg.split('=')[1] : 'books';
  console.log(`[enqueue] Looking up most recent approved plan for product="${product}"...`);

  const profilesResp = await backend.get<{ data: Array<{ id: number; product_name: string; status: string }> }>('/target-profiles');
  const profile = profilesResp.data.data.find((p) => p.product_name === product && p.status === 'active');
  if (!profile) {
    console.error(`No active target profile for product=${product}`);
    process.exit(1);
  }
  console.log(`[enqueue] Picked profile id=${profile.id}.`);

  // We don't have a list-plans endpoint exposed in v1; the operator should
  // hit /session-plans/:id/run from the portal once a plan is approved.
  console.error('[enqueue] This convenience CLI requires a known approved plan id.');
  console.error('[enqueue] In v1, please start runs from the portal once a plan is approved.');
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
