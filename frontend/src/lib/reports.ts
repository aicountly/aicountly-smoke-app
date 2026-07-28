import { api } from '@/lib/api';
import type { AxiosError } from 'axios';

function reportErrorMessage(err: unknown, format: 'html' | 'json'): string {
  const ax = err as AxiosError<{ message?: string; error?: string }>;
  const msg = ax?.response?.data?.message || ax?.response?.data?.error;
  if (ax?.response?.status === 404) {
    return msg || `${format.toUpperCase()} report file is missing on the server.`;
  }
  if (ax?.response?.status === 401) {
    return 'Session expired. Please sign in again.';
  }
  return msg || (err instanceof Error ? err.message : `Failed to open ${format.toUpperCase()} report.`);
}

/**
 * Open a report in a new tab. Opens the window synchronously first so popup
 * blockers do not swallow the navigation after the async fetch.
 */
export async function openReport(id: number, format: 'html' | 'json'): Promise<void> {
  const win = window.open('about:blank', '_blank');
  try {
    const res = await api.get(`/reports/${id}/${format}`, { responseType: 'text' });
    const mime = format === 'html' ? 'text/html;charset=utf-8' : 'application/json';
    const url = URL.createObjectURL(new Blob([res.data as string], { type: mime }));
    if (win) {
      win.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    const message = reportErrorMessage(err, format);
    if (win) {
      win.document.title = 'Report error';
      win.document.body.innerHTML = `<pre style="font:14px/1.5 system-ui;padding:24px;color:#7f1d1d">${message}</pre>`;
    } else {
      window.alert(message);
    }
    throw err;
  }
}
