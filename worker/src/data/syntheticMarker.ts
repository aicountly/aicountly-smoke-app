/**
 * Synthetic data marker applied to free-text values the vision agent types into
 * live forms. Leaves numeric / date / time / currency fields untouched so
 * validation still passes.
 */

export const SMOKE_MARKER = (process.env.SMOKE_DATA_MARKER || 'SMOKE-').trim() || 'SMOKE-';

export type MarkerFieldHint = {
  type?: string;
  name?: string;
  tag?: string;
};

const SKIP_TYPES = new Set([
  'number', 'date', 'datetime-local', 'month', 'week', 'time',
  'range', 'color', 'checkbox', 'radio', 'file', 'hidden',
]);

export function applyMarker(value: string, hint: MarkerFieldHint = {}): string {
  const raw = String(value ?? '');
  if (!raw) return raw;
  const type = String(hint.type || '').toLowerCase();
  if (SKIP_TYPES.has(type)) return raw;
  if (isNumericLike(raw) || isDateLike(raw) || isTimeLike(raw) || isCurrencyCode(raw)) {
    return raw;
  }
  if (type === 'email' || looksLikeEmail(raw)) {
    return markEmail(raw);
  }
  if (raw.toUpperCase().startsWith(SMOKE_MARKER.toUpperCase())
    || raw.toUpperCase().startsWith('SMOKE ')) {
    return raw;
  }
  return `${SMOKE_MARKER}${raw}`;
}

function markEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return `${SMOKE_MARKER}${value}`;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.toLowerCase().startsWith('smoke.') || local.toLowerCase().startsWith('smoke-')) {
    return value;
  }
  return `smoke.${local}@${domain}`;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isNumericLike(value: string): boolean {
  return /^-?\d+(\.\d+)?%?$/.test(value.trim());
}

function isDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value.trim())
    || /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim());
}

function isTimeLike(value: string): boolean {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim());
}

function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value.trim());
}
