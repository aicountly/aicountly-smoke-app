import { backend } from '../backend.js';
import axios from 'axios';

export type BrainImage = {
  data: string;
  mime_type?: string;
};

export class BrainUnavailableError extends Error {
  constructor(
    public readonly provider: string,
    public readonly detail: string,
  ) {
    super(`Brain provider ${provider || 'unknown'} unavailable: ${detail}`);
    this.name = 'BrainUnavailableError';
  }
}

/**
 * Worker-side facade that delegates all AI calls back to the backend. The
 * worker never sees provider API keys directly.
 */
export async function invokeBrain(
  task: string,
  systemPrompt: string,
  userPrompt: string,
  context: Record<string, unknown> = {},
  images: BrainImage[] = [],
): Promise<{ task: string; final: unknown; arbiter: string; parallel: unknown }> {
  try {
    const r = await backend.post<{ data: { task: string; final: unknown; arbiter: string; parallel: unknown } }>(
      '/worker/brain/invoke',
      { task, system_prompt: systemPrompt, user_prompt: userPrompt, context, images },
      // Vision: 30s. Text (synthetic_data etc.): 50s — backend caps provider wait at 45s.
      { timeout: images.length ? 30_000 : 50_000 },
    );
    return r.data.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const body = error.response?.data as { error?: string; provider?: string; detail?: string } | undefined;
      if (error.response?.status === 503 || body?.error === 'brain_unavailable') {
        throw new BrainUnavailableError(
          String(body?.provider ?? 'unknown'),
          String(body?.detail ?? error.message),
        );
      }
    }
    throw error;
  }
}

export async function brainHealth(): Promise<{
  vision_available: boolean;
  vision_providers: string[];
}> {
  const response = await backend.get<{ data: {
    vision_available: boolean;
    vision_providers: string[];
  } }>('/worker/brain/health', { timeout: 10_000 });
  return response.data.data;
}
