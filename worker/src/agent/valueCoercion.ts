/**
 * Typed values the browser will actually accept.
 *
 * Playwright's fill() on a date/time input demands the wire format the HTML spec
 * defines for that input type and throws "Malformed value" for anything else.
 * A vision model reads the on-screen placeholder instead, so it offers dd/mm/yyyy
 * or mm/dd/yyyy and the step fails for a reason that has nothing to do with the
 * product. Coercion decides only what value lands in the field; whether the
 * product should have accepted dd/mm/yyyy is judged separately by dateFieldProbe.
 */

import { isoDate } from '../forms/fieldSynthesis.js';
import { stripMarker } from '../data/syntheticMarker.js';

export type CoercionHint = {
  type?: string;
  name?: string;
  tag?: string;
};

const TEMPORAL_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local']);

export function coerceForField(value: string, hint: CoercionHint = {}, now: Date = new Date()): string {
  const type = String(hint.type || '').toLowerCase();
  const raw = String(value ?? '');
  if (!TEMPORAL_TYPES.has(type) && type !== 'number' && type !== 'range') return raw;

  const cleaned = stripMarker(raw);
  if (type === 'number' || type === 'range') return coerceNumber(cleaned);
  if (type === 'time') return coerceTime(cleaned);

  const parsed = parseDateParts(cleaned) ?? dateParts(now);
  const time = coerceTime(cleaned) || '00:00';
  switch (type) {
    case 'month':
      return `${parsed.year}-${parsed.month}`;
    case 'week':
      return isoWeek(parsed);
    case 'datetime-local':
      return `${parsed.year}-${parsed.month}-${parsed.day}T${time}`;
    default:
      return `${parsed.year}-${parsed.month}-${parsed.day}`;
  }
}

/** True for the input types whose wire format differs from what a human types. */
export function isTemporalType(type: string | undefined): boolean {
  return TEMPORAL_TYPES.has(String(type || '').toLowerCase());
}

function coerceNumber(value: string): string {
  const match = /-?\d+(?:\.\d+)?/.exec(value.replace(/,/g, ''));
  return match ? match[0] : '1';
}

/** "" when the value carries no time at all, so callers can default it. */
function coerceTime(value: string): string {
  const match = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i.exec(value);
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return '';
  return `${pad(hour)}:${pad(minute)}`;
}

type DateParts = { year: string; month: string; day: string };

function dateParts(date: Date): DateParts {
  const [year, month, day] = isoDate(date).split('-');
  return { year, month, day };
}

function parseDateParts(value: string): DateParts | null {
  const iso = /(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(value);
  if (iso) return validParts(iso[1], iso[2], iso[3] ?? '01');

  const slashed = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(value);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    // Only one reading can be right once a component exceeds 12. When both are
    // ambiguous, read it the Indian way: this product is India-first.
    const dayFirst = first > 12 ? true : second > 12 ? false : true;
    return dayFirst
      ? validParts(slashed[3], slashed[2], slashed[1])
      : validParts(slashed[3], slashed[1], slashed[2]);
  }

  const prose = Date.parse(value);
  if (!Number.isNaN(prose)) return dateParts(new Date(prose));
  return null;
}

function validParts(year: string, month: string, day: string): DateParts | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { year: String(y).padStart(4, '0'), month: pad(m), day: pad(d) };
}

/** ISO-8601 week of the date, as <input type="week"> expects it. */
function isoWeek(parts: DateParts): string {
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
