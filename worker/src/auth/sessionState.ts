/**
 * The signed-in browser state, shared by every session in one run.
 *
 * Each session is its own job with its own browser, so without this every session
 * signs in from scratch and lands back on the company picker — three wasted actions
 * before it can look at anything, repeated ten times a run.
 *
 * Deliberately not kept under the run's reports directory: reports are rsynced into
 * the public document root, and this file holds live session cookies.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import type { Job } from '../backend.js';

/** No run lasts this long, so anything older is a leftover holding dead cookies. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1_000;

function stateDir(): string {
  return path.join(os.tmpdir(), 'aicountly-smoke-auth');
}

export function storageStatePath(runId: number | string): string {
  return path.join(stateDir(), `run-${runId}.json`);
}

/** The saved state for this run, or undefined when this is the run's first session. */
export function loadStorageState(job: Job): string | undefined {
  const file = storageStatePath(job.run_id);
  return existsSync(file) ? file : undefined;
}

export async function saveStorageState(context: BrowserContext, job: Job): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const state = await context.storageState();
  await writeFile(storageStatePath(job.run_id), JSON.stringify(state), { mode: 0o600 });
  // Nothing tells a session that it is a run's last, so old runs are swept here
  // rather than left to keep live cookies on disk indefinitely.
  await pruneStaleState().catch(() => {});
}

export async function clearStorageState(runId: number | string): Promise<void> {
  await rm(storageStatePath(runId), { force: true }).catch(() => {});
}

async function pruneStaleState(): Promise<void> {
  const dir = stateDir();
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!/^run-.+\.json$/.test(entry)) continue;
    const file = path.join(dir, entry);
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => {});
  }
}
