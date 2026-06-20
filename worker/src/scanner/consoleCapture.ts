import type { ConsoleMessage, Page } from 'playwright';

export type ConsoleEvent = { type: string; text: string; location?: string };

/** Attaches a console listener that buffers errors / warnings during a session. */
export function attachConsoleCapture(page: Page): { events: ConsoleEvent[]; detach: () => void } {
  const events: ConsoleEvent[] = [];
  const handler = (msg: ConsoleMessage) => {
    const t = msg.type();
    if (t !== 'error' && t !== 'warning') return;
    const loc = msg.location();
    events.push({ type: t, text: msg.text(), location: loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined });
  };
  const errHandler = (err: Error) => {
    events.push({ type: 'pageerror', text: err.message });
  };
  page.on('console', handler);
  page.on('pageerror', errHandler);
  return {
    events,
    detach() {
      page.off('console', handler);
      page.off('pageerror', errHandler);
    },
  };
}
