import axios from 'axios';
import { config } from './config.js';

export const backend = axios.create({
  baseURL: config.backendUrl,
  timeout: 60_000,
  headers: {
    'X-Worker-Token': config.workerToken,
    'Content-Type': 'application/json',
  },
});

export type Job = {
  job_id: number;
  run_id: number;
  run_code: string;
  expires_at: string;
  session: SessionRow;
  run: RunRow;
  profile: ProfileRow;
};

export type SessionRow = {
  id: number;
  plan_id: number;
  ordinal: number;
  name: string;
  menu_path: string;
  description: string;
  scope_json: string;
  allowed_actions_json: string;
  destructive_allowed: boolean;
  expected_screens: number;
};
export type RunRow = {
  id: number;
  run_code: string;
  product_name: string;
  environment: string;
  reports_dir: string;
  target_profile_id: number;
};
export type ProfileRow = {
  id: number;
  profile_name: string;
  product_name: string;
  environment: string;
  base_url: string;
  login_url: string;
  username: string;
  observer_mode: boolean;
  read_only: boolean;
  production_restriction: boolean;
  allow_safe_demo: boolean;
  login_strategy: string;
  allowed_modules: string | string[];
  allowed_domains: string | string[];
};

export async function leaseNextJob(): Promise<Job | null> {
  const r = await backend.post<{ data: Job | null }>('/worker/lease', {
    worker_id: config.workerId,
    lease_seconds: config.leaseSeconds,
  });
  return r.data.data ?? null;
}

export async function heartbeat(jobId: number): Promise<void> {
  await backend.post(`/worker/jobs/${jobId}/heartbeat`, { lease_seconds: config.leaseSeconds });
}

export async function complete(jobId: number, payload: Record<string, unknown> = {}): Promise<void> {
  await backend.post(`/worker/jobs/${jobId}/complete`, payload);
}

export async function fail(jobId: number, error: string): Promise<void> {
  await backend.post(`/worker/jobs/${jobId}/fail`, { error });
}

export async function decryptCredential(profileId: number): Promise<string | null> {
  const r = await backend.post<{ plaintext: string | null }>(`/worker/credentials/${profileId}/decrypt`, {});
  return r.data.plaintext ?? null;
}

export async function recordResult(payload: Record<string, unknown>): Promise<number> {
  const r = await backend.post<{ id: number }>('/worker/results', payload);
  return r.data.id;
}

export async function recordInventory(rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    await backend.post('/worker/inventory', row);
  }
}

export async function recordUxIssues(rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    await backend.post('/worker/ux-issues', row);
  }
}

export async function recordFeatureGaps(rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    await backend.post('/worker/feature-gaps', row);
  }
}

export async function recordReport(payload: Record<string, unknown>): Promise<number> {
  const r = await backend.post<{ id: number }>('/worker/reports', payload);
  return r.data.id;
}

export async function finalizeRun(runId: number): Promise<void> {
  await backend.post(`/worker/runs/${runId}/finalize`, {});
}
