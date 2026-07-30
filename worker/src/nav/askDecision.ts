import type { Page } from 'playwright';
import { appendLog, backend, heartbeat, type Job } from '../backend.js';
import { invokeBrain } from '../brain/ensemble.js';
import { config } from '../config.js';
import { autonomousOption } from './autonomousChoice.js';

export const NAV_ACTIONS = [
  'open_company',
  'create_company',
  'dismiss_overlay',
  'skip_target',
  'navigate_href',
  'rescan_menus',
  'abort_session',
  'approve_upload',
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
  source: 'memory' | 'user' | 'auto';
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
  /** Set after a remembered choice failed, so the operator is asked again. */
  ignoreMemory?: boolean;
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

  const memory = input.ignoreMemory
    ? null
    : await recallDecision(input.job, input.situationKey).catch(async (error: unknown) => {
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
      await persistPreAnsweredDecision(input, option, 'memory', memory.payload?.free_text ?? undefined).catch(async (error: unknown) => {
        await log(input.job, `Could not audit remembered decision: ${errorMessage(error)}`, 'warn');
      });
      await log(input.job, `Reused remembered choice: ${option.label}`);
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

  // A parked job is a dead run: nobody is watching a smoke worker at 2am, and the
  // 30-minute wait below ends in a failed session either way. When autonomy is on
  // we take the recommended route and record it, so the run keeps moving and the
  // audit trail still says exactly what was chosen and why.
  if (config.autonomous) {
    const auto = autonomousOption(input.job.profile.environment, proposed.options, proposed.recommended);
    if (auto) {
      const passedOver = proposed.recommended && auto.id !== proposed.recommended
        ? ` (${proposed.recommended} is not permitted on ${input.job.profile.environment})`
        : '';
      await persistPreAnsweredDecision(input, auto, 'auto').catch(async (error: unknown) => {
        await log(input.job, `Could not audit autonomous decision: ${errorMessage(error)}`, 'warn');
      });
      await log(
        input.job,
        `Decided "${auto.label}" without asking (autonomous mode) for ${input.situationKey}${passedOver}`,
      );
      return { option: auto, source: 'auto', explicitApproval: true };
    }
    await log(
      input.job,
      `No safe autonomous option for ${input.situationKey}; asking an operator.`,
      'warn',
    );
  }

  const response = await backend.post<{ data: DecisionRow }>('/worker/decisions', {
    run_id: input.job.run_id,
    session_id: input.job.session.id,
    job_id: input.job.job_id,
    situation_key: input.situationKey,
    question: proposed.question,
    options: proposed.options,
    source: 'user',
    context: {
      ...(input.context ?? {}),
      url: input.page.url(),
      title: await input.page.title().catch(() => ''),
      recommended: proposed.recommended,
      source: 'user',
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

  await backend.post(`/worker/decisions/${decisionId}/timeout`).catch(async (error: unknown) => {
    await log(input.job, `Could not mark decision timed_out: ${errorMessage(error)}`, 'warn');
  });
  throw new Error(`Timed out waiting ${Math.round(timeoutMs / 60_000)} minutes for decision ${decisionId}.`);
}

/**
 * Ends the run's own decisions in the same table an operator would answer, so a
 * remembered or autonomous choice is as auditable as a human one.
 */
async function persistPreAnsweredDecision(
  input: AskDecisionInput,
  option: DecisionOption,
  source: 'memory' | 'auto',
  freeText?: string,
): Promise<void> {
  await backend.post<{ data: DecisionRow }>('/worker/decisions', {
    run_id: input.job.run_id,
    session_id: input.job.session.id,
    job_id: input.job.job_id,
    situation_key: input.situationKey,
    question: input.question,
    options: input.options,
    source,
    selected_option: option.id,
    ...(freeText ? { free_text: freeText } : {}),
    context: {
      ...(input.context ?? {}),
      url: input.page.url(),
      title: await input.page.title().catch(() => ''),
      source,
    },
    ...(input.screenshotPath ? { screenshot_path: input.screenshotPath } : {}),
  });
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

/** Drop a remembered choice that failed at runtime so it cannot false-succeed forever. */
export async function forgetDecisionMemory(job: Job, situationKey: string): Promise<void> {
  await backend.delete('/worker/decision-memory', {
    params: {
      product_name: job.run.product_name,
      environment: job.run.environment,
      situation_key: situationKey,
    },
  });
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
        // The tier decides which options are even open to us, so a recommendation
        // made without it tends to name one this target will refuse.
        product: input.job.run.product_name,
        environment: input.job.profile.environment,
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
