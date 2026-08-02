import type { NetworkEvent } from './networkCapture.js';

/**
 * Shared analytics / soft-asset / expected-conflict classifiers used by
 * networkCapture (drop at source), uxReviewEngine (severity), and
 * cursorPromptBuilder (evidence stripping). Keep one regex here so the three
 * layers cannot drift.
 */

export const ANALYTICS_NOISE_REGEX =
  /google-analytics\.com|\/g\/collect|gtm\.js|gtm=|googletagmanager|facebook\.com\/tr|hotjar|segment\.|mixpanel|sentry\.io/i;

/** Optional chrome assets: logos, favicons, images, fonts. */
export const SOFT_ASSET_URL_REGEX =
  /\/logo\b|favicon|\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)(?:\?|$)/i;

export function isAnalyticsNoise(url: string): boolean {
  return ANALYTICS_NOISE_REGEX.test(url);
}

export function isSoftAssetFailure(event: Pick<NetworkEvent, 'url' | 'content_type'>): boolean {
  if (SOFT_ASSET_URL_REGEX.test(event.url)) return true;
  const ct = (event.content_type ?? '').toLowerCase();
  return ct.startsWith('image/') || ct.startsWith('font/') || ct.includes('font-');
}

/** Idempotent create/update conflicts during authenticated flows — evidence only. */
export function isExpectedCreateConflict(event: Pick<NetworkEvent, 'method' | 'status'>): boolean {
  const method = (event.method ?? '').toUpperCase();
  return (method === 'POST' || method === 'PUT') && event.status === 409;
}

export function isHardNetworkFailure(event: NetworkEvent): boolean {
  if (isAnalyticsNoise(event.url)) return false;
  if (isSoftAssetFailure(event)) return false;
  if (isExpectedCreateConflict(event)) return false;
  return true;
}

export type ClassifiedNetwork = {
  hard: NetworkEvent[];
  soft: NetworkEvent[];
  conflicts: NetworkEvent[];
  ignored: NetworkEvent[];
};

export function classifyNetworkEvents(events: NetworkEvent[]): ClassifiedNetwork {
  const hard: NetworkEvent[] = [];
  const soft: NetworkEvent[] = [];
  const conflicts: NetworkEvent[] = [];
  const ignored: NetworkEvent[] = [];
  for (const event of events) {
    if (isAnalyticsNoise(event.url)) {
      ignored.push(event);
      continue;
    }
    if (isExpectedCreateConflict(event)) {
      conflicts.push(event);
      continue;
    }
    if (isSoftAssetFailure(event)) {
      soft.push(event);
      continue;
    }
    hard.push(event);
  }
  return { hard, soft, conflicts, ignored };
}
