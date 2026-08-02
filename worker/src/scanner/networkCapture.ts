import type { Page, Response } from 'playwright';
import { isAnalyticsNoise } from './networkNoise.js';

export type NetworkEvent = {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  duration_ms?: number;
  content_type?: string;
};

export function attachNetworkCapture(page: Page): { events: NetworkEvent[]; detach: () => void } {
  const events: NetworkEvent[] = [];
  const respHandler = async (resp: Response) => {
    try {
      const status = resp.status();
      if (status < 400) return; // only capture failures + 4xx/5xx
      const url = resp.url();
      if (isAnalyticsNoise(url)) return;
      let contentType = '';
      try {
        contentType = resp.headers()['content-type'] || '';
      } catch { /* ignore */ }
      events.push({
        url,
        method: resp.request().method(),
        status,
        ok: resp.ok(),
        content_type: contentType || undefined,
      });
    } catch { /* ignore */ }
  };
  const failHandler = (req: import('playwright').Request) => {
    const url = req.url();
    if (isAnalyticsNoise(url)) return;
    events.push({
      url,
      method: req.method(),
      status: 0,
      ok: false,
    });
  };
  page.on('response', respHandler);
  page.on('requestfailed', failHandler);
  return {
    events,
    detach() {
      page.off('response', respHandler);
      page.off('requestfailed', failHandler);
    },
  };
}
