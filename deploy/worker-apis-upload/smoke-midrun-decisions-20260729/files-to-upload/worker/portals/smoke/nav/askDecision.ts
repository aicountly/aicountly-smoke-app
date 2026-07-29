import type { Page } from 'playwright';
import { appendLog, backend, heartbeat, type Job } from '../backend.js';
import { invokeBrain } from '../brain/ensemble.js';

export const NAV_ACTIONS = [
  'open_company',
  'create_company',
  'dismiss_overlay',
  'skip_target',
  'navigate_href',
  'rescan_menus',
  'abort_session',
] as const;

export type NavAction = typeof NAV_ACTIONS[number];

export type DecisionOption = {
  id: string;
  label: string;
  action: NavAction;
  href?: string;
  company_name?: string;
};

export type DecisionChoice = {
  option: DecisionOption;
  freeText?: string;
  source: 'memory' | 'user';
  explicitApproval: true;
};

export type AskDecisionInput = {
  job: Job;
  page: Page;
  situationKey: string;
  question: string;
  options: DecisionOption[];
  context?: Record<string, unknown>;
  screenshotPath?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

type BrainDecision = {
  question: string;
  options: DecisionOption[];
  recommended?: string;
};

type DecisionRow = {
  id: number;
  status: string;
  selected_option?: string | null;
  free_text?: string | null;
  options?: DecisionOption[];
};

type DecisionMemory = {
  selected_option: string;
  payload?: {
    selected_option?: string;
    free_text?: string | null;
    option?: DecisionOption;
  };
};

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export async function askOrRecallDecision(input: AskDecisionInput): Promise<DecisionChoice> {
  if (input.options.length === 0) throw new Error('A navigation decision requires at least one option.');

  const memory = await recallDecision(input.job, input.situationKey).catch(async (error: unknown) => {
    await log(input.job, `Decision memory lookup failed: ${errorMessage(error)}`, 'warn');
    return null;
  });
  if (memory) {
    const option = resolveOption(
      memory.payload?.option,
      memory.payload?.selected_option ?? memory.selected_option,
      input.options,
    );
    if (option) {
      await log(input.job, `Recalled decision "${option.label}" for ${input.situationKey}`);
      return {
        option,
        freeText: memory.payload?.free_text ?? undefined,
        source: 'memory',
        explicitApproval: true,
      };
    }
    await log(input.job, `Ignored invalid remembered decision for ${input.situationKey}`, 'warn');
  }

  const proposed = await proposeDecision(input);
  const response = await backend.post<{ data: DecisionRow }>('/worker/decisions', {
    run_id: input.job.run_id,
    session_id: input.job.session.id,
    job_id: input.job.job_id,
    situation_key: input.situationKey,
    question: proposed.question,
    options: proposed.options,
    context: {
      url: input.page.url(),
      title: await input.page.title().catch(() => ''),
      recommended: proposed.recommended,
      ...(input.context ?? {}),
    },
    ...(input.screenshotPath ? { screenshot_path: input.screenshotPath } : {}),
  });

  const decisionId = Number(response.data.data?.id);
  if (!decisionId) throw new Error('Decision API did not return a decision id.');

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = input.pollIntervalMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await heartbeat(input.job.job_id).catch(async (error: unknown) => {
      await log(input.job, `Decision heartbeat failed: ${errorMessage(error)}`, 'warn');
    });

    const row = await backend.get<{ data: DecisionRow }>(`/worker/decisions/${decisionId}`)
      .then((polled) => polled.data.data)
      .catch(async (error: unknown) => {
        await log(input.job, `Decision poll failed; retrying: ${errorMessage(error)}`, 'warn');
        return null;
      });
    if (!row) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (row.status === 'answered') {
      const option = resolveOption(undefined, row.selected_option ?? '', row.options ?? proposed.options);
      if (!option) throw new Error(`Decision ${decisionId} returned an unknown selected option.`);
      await log(input.job, `User decided "${option.label}" for ${input.situationKey}`);
      return {
        option,
        freeText: row.free_text ?? undefined,
        source: 'user',
        explicitApproval: true,
      };
    }
    if (row.status === 'cancelled' || row.status === 'timed_out') {
      throw new Error(`Decision ${decisionId} was ${row.status}.`);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`Timed out waiting ${Math.round(timeoutMs / 60_000)} minutes for decision ${decisionId}.`);
}

async function recallDecision(job: Job, situationKey: string): Promise<DecisionMemory | null> {
  const response = await backend.get<{ data: DecisionMemory | null }>('/worker/decision-memory', {
    params: {
      product_name: job.run.product_name,
      environment: job.run.environment,
      situation_key: situationKey,
    },
  });
  return response.data.data ?? null;
}

async function proposeDecision(input: AskDecisionInput): Promise<BrainDecision> {
  const fallback: BrainDecision = {
    question: input.question,
    options: input.options,
    recommended: input.options[0]?.id,
  };
  try {
    const result = await invokeBrain(
      'ask_user',
      'Return only a practical mid-run navigation decision. Never invent actions outside the supplied action enum.',
      input.question,
      {
        situation_key: input.situationKey,
        url: input.page.url(),
        options: input.options,
        ...(input.context ?? {}),
      },
    );
    return normalizeBrainDecision(result.final, fallback);
  } catch (error) {
    await log(input.job, `Brain decision proposal failed; using deterministic options: ${errorMessage(error)}`, 'warn');
    return fallback;
  }
}

function normalizeBrainDecision(value: unknown, fallback: BrainDecision): BrainDecision {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<BrainDecision>;
  const allowed = new Set(NAV_ACTIONS);
  const candidateOptions = Array.isArray(candidate.options) ? candidate.options : [];
  const options = fallback.options.map((supplied) => {
    const proposed = candidateOptions.find((option) => (
      option
      && typeof option === 'object'
      && String(option.id ?? '') === supplied.id
      && String(option.action ?? '') === supplied.action
      && allowed.has(option.action as NavAction)
    ));
    return proposed && String(proposed.label ?? '').trim()
      ? { ...supplied, label: String(proposed.label).trim() }
      : supplied;
  });
  return {
    question: typeof candidate.question === 'string' && candidate.question.trim()
      ? candidate.question.trim()
      : fallback.question,
    options,
    recommended: typeof candidate.recommended === 'string'
      && options.some((option) => option.id === candidate.recommended)
      ? candidate.recommended
      : fallback.recommended,
  };
}

function resolveOption(
  payloadOption: DecisionOption | undefined,
  selectedId: string,
  options: DecisionOption[],
): DecisionOption | null {
  const allowed = new Set(NAV_ACTIONS);
  const offered = options.find((option) => option.id === selectedId && allowed.has(option.action));
  if (!offered) return null;
  if (
    payloadOption
    && payloadOption.id === offered.id
    && payloadOption.action === offered.action
    && allowed.has(payloadOption.action)
  ) {
    return { ...offered, ...payloadOption };
  }
  return offered;
}

async function log(job: Job, message: string, level: 'info' | 'warn' = 'info'): Promise<void> {
  await appendLog({
    run_id: job.run_id,
    session_id: job.session.id,
    job_id: job.job_id,
    level,
    message,
  }).catch(() => {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
