/**
 * Turns a list of form fields into the values the run will type.
 *
 * Heuristics answer first because they are free, instant and offline. Only the
 * fields they cannot map — and that the form insists on — are worth an LLM round
 * trip. Whatever the model returns is then filtered back through the same safety
 * rules, so a confident model cannot talk the run into inventing a GSTIN.
 */

import {
  isUnsafeToFill,
  lastResortValue,
  synthesizeFieldValue,
  type FormFieldDescriptor,
  type SynthesisOptions,
} from './fieldSynthesis.js';

export type PlannedField = {
  key: string;
  field: FormFieldDescriptor;
  value: string | null;
  source: 'heuristic' | 'brain' | 'fallback' | 'unresolved';
};

/** Stable identity for a field across the heuristic pass, the brain call and the fill. */
export function fieldKey(field: FormFieldDescriptor, index: number): string {
  const named = field.name || field.id;
  if (named) return named;
  const described = field.ariaLabel || field.label || field.placeholder;
  return described ? `${described.slice(0, 40)}#${index}` : `field#${index}`;
}

export function planFromHeuristics(
  fields: FormFieldDescriptor[],
  options: SynthesisOptions = {},
): PlannedField[] {
  return fields.map((field, index) => {
    const value = synthesizeFieldValue(field, options);
    return {
      key: fieldKey(field, index),
      field,
      value,
      source: value === null ? 'unresolved' : 'heuristic',
    };
  });
}

/**
 * Fields worth asking a model about: required, still unanswered, and safe to
 * fill. An optional field we could not map is simply left alone.
 */
export function fieldsNeedingBrain(plan: PlannedField[]): PlannedField[] {
  return plan.filter((entry) => entry.source === 'unresolved'
    && entry.field.required
    && !isUnsafeToFill(entry.field));
}

/**
 * Applies model-proposed values on top of the heuristic plan. A proposal is only
 * accepted for a field that is still unresolved and safe to fill: the model may
 * fill a gap, never overrule a refusal.
 */
export function mergeBrainValues(
  plan: PlannedField[],
  proposed: Record<string, unknown>,
): PlannedField[] {
  return plan.map((entry) => {
    if (entry.source !== 'unresolved') return entry;
    if (isUnsafeToFill(entry.field)) return entry;
    const raw = proposed[entry.key];
    const value = normalizeProposedValue(raw);
    if (value === null) return entry;
    return { ...entry, value, source: 'brain' };
  });
}

/**
 * Last word on the plan: a required field still unanswered after heuristics and
 * the brain gets a bland placeholder, because leaving it empty means the form
 * will not submit and the screen behind it is never seen.
 */
export function applyLastResort(plan: PlannedField[]): PlannedField[] {
  return plan.map((entry) => {
    if (entry.source !== 'unresolved' || !entry.field.required) return entry;
    const value = lastResortValue(entry.field);
    return value === null ? entry : { ...entry, value, source: 'fallback' };
  });
}

function normalizeProposedValue(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // A model that does not know an answer tends to say so in prose rather than
  // return nothing; those sentences must not be typed into the form.
  if (trimmed.length > 200) return null;
  if (/^(null|undefined|n\/?a|unknown|none|tbd|todo|<[^>]*>|\{\{.*\}\})$/i.test(trimmed)) return null;
  if (/^(i (cannot|can't|am unable)|sorry|as an ai)\b/i.test(trimmed)) return null;
  return trimmed;
}

/** "label=value" pairs for logs and failure messages. */
export function describePlan(plan: PlannedField[]): string[] {
  return plan
    .filter((entry) => entry.value !== null)
    .map((entry) => `${entry.key}=${entry.value}`);
}

/** The JSON payload handed to the brain: labels only, never page content. */
export function brainFieldPayload(entries: PlannedField[]): Array<Record<string, unknown>> {
  return entries.map((entry) => ({
    key: entry.key,
    tag: entry.field.tag,
    type: entry.field.type,
    label: entry.field.label || entry.field.ariaLabel || entry.field.placeholder || entry.field.name,
    required: entry.field.required,
  }));
}
