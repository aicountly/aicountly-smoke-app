/**
 * Asks the brain for values the local heuristics could not map.
 *
 * This is deliberately a top-up, not the primary path: the heuristics already
 * answered every field they recognise, so a missing provider, a slow model or a
 * malformed reply costs the run nothing. Failures resolve to "no extra values".
 */

import { invokeBrain } from '../brain/ensemble.js';
import { brainFieldPayload, type PlannedField } from './formFillPlan.js';

const SYSTEM_PROMPT = `You fill unfamiliar forms during an automated smoke test of an accounting SaaS product.
Return ONLY a JSON object of the form {"values":{"<field key>":"<value>"}}.
Rules:
- Use the exact field keys you were given. Omit any key you cannot fill safely.
- Values must be obviously synthetic test data, plausible for the field's label and type.
- Keep money and quantity values at 0 or 1. Use ISO dates (YYYY-MM-DD). Indian financial years run 1 April to 31 March.
- Never invent a checksum or registry identifier (GSTIN, CIN, PAN of a real party, bank account, IFSC, Aadhaar).
- Never return prose, explanations, apologies or placeholders like "N/A" — omit the key instead.`;

export type FormFillBrainInput = {
  entries: PlannedField[];
  product: string;
  environment: string;
  url: string;
  formLabel: string;
  /** Validation messages from a previous rejected submit, when retrying. */
  formErrors?: string[];
};

export async function proposeFormValues(input: FormFillBrainInput): Promise<Record<string, unknown>> {
  if (input.entries.length === 0) return {};
  const payload = {
    form: input.formLabel,
    url: input.url,
    fields: brainFieldPayload(input.entries),
    ...(input.formErrors?.length ? { validation_errors: input.formErrors } : {}),
  };
  const result = await invokeBrain('form_fill', SYSTEM_PROMPT, JSON.stringify(payload), {
    expect_json: true,
    product: input.product,
    environment: input.environment,
    fields: payload.fields,
  });
  return readValues(result.final);
}

/** Accepts `{values:{...}}` or a bare `{...}` map; anything else yields no values. */
export function readValues(final: unknown): Record<string, unknown> {
  if (!final || typeof final !== 'object' || Array.isArray(final)) return {};
  const record = final as Record<string, unknown>;
  const nested = record.values;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  // A deterministic fallback answers with a note and no values.
  if ('note' in record && Object.keys(record).length === 1) return {};
  return record;
}
