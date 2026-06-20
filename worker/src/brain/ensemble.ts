import { backend } from '../backend.js';

/**
 * Worker-side facade that delegates all AI calls back to the backend. The
 * worker never sees provider API keys directly.
 */
export async function invokeBrain(
  task: string,
  systemPrompt: string,
  userPrompt: string,
  context: Record<string, unknown> = {},
): Promise<{ task: string; final: unknown; arbiter: string; parallel: unknown }> {
  const r = await backend.post<{ data: { task: string; final: unknown; arbiter: string; parallel: unknown } }>(
    '/brain/invoke',
    { task, system_prompt: systemPrompt, user_prompt: userPrompt, context },
  );
  return r.data.data;
}
