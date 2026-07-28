/** Display timezone for run logs and screenshot capture times. */
export const APP_TIMEZONE = 'Asia/Kolkata';

/**
 * Format a DB/API timestamp for the UI in Asia/Kolkata.
 * - Values with Z / offset are converted to Asia/Kolkata.
 * - Naive values (no zone) are treated as Asia/Kolkata wall-clock (backend appTimezone).
 */
export function formatAppDateTime(value?: string | null): string {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  // "2026-07-28 08:41:41.714964" → parseable form
  let normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  normalized = normalized.replace(/(\.\d{3})\d+$/, '$1'); // keep ms only

  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized);
  const date = new Date(hasZone ? normalized : `${normalized}+05:30`);
  if (Number.isNaN(date.getTime())) {
    // Fallback: strip fractional seconds for display
    return raw.replace(/\.\d+$/, '');
  }

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
