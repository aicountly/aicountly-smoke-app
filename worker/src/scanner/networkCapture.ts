import type { Page, Response } from 'playwright';

export type NetworkEvent = {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  duration_ms?: number;
};

export function attachNetworkCapture(page: Page): { events: NetworkEvent[]; detach: () => void } {
  const events: NetworkEvent[] = [];
  const respHandler = async (resp: Response) => {
    try {
      const status = resp.status();
      if (status < 400) return; // only capture failures + 4xx/5xx
      events.push({
        url: resp.url(),
        method: resp.request().method(),
        status,
        ok: resp.ok(),
      });
    } catch { /* ignore */ }
  };
  const failHandler = (req: import('playwright').Request) => {
    events.push({
      url: req.url(),
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
