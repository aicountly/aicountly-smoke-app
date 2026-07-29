import { finalizeRun } from '../backend.js';

/**
 * The PHP backend owns the canonical Final Report Builder (it has DB access
 * and is consistent with the worker-token boundary). The worker simply asks
 * the backend to finalise once it observes the last session of a run was
 * completed.
 */
export async function finalizeIfLast(runId: number): Promise<void> {
  await finalizeRun(runId);
}
