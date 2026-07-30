/**
 * What actually lands in a field once the wire-format coercion and the synthetic
 * marker have had their say. Shared by the single-field executor and the batch
 * filler so a value typed in a batch of ten is rewritten on exactly the same
 * terms as one typed on its own.
 */

import { applyMarker, type MarkerFieldHint } from '../data/syntheticMarker.js';
import { CODE_FIELD_PATTERN } from '../forms/fieldSynthesis.js';
import type { MarkDescriptor } from './marks.js';
import { coerceForField } from './valueCoercion.js';

/**
 * Alphanumeric-only comparison so a marker's own punctuation (hyphens, case)
 * does not itself register as a "material" rewrite of what the model asked for.
 */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * `adjustedFrom` is set only when the rewrite is material, because the model
 * cannot control what the marker does to what it typed and kept re-fighting a
 * value it had already lost the argument on.
 */
export function resolveTypedValue(
  text: string,
  descriptor?: MarkDescriptor,
): { typedValue: string; adjustedFrom?: string } {
  const hint: MarkerFieldHint = {
    type: descriptor?.type,
    name: descriptor?.name,
    tag: descriptor?.tag,
    looksLikeCode: CODE_FIELD_PATTERN.test(descriptor?.name ?? ''),
  };
  const typedValue = applyMarker(coerceForField(text, hint), hint);
  return normalizeForComparison(text) === normalizeForComparison(typedValue)
    ? { typedValue }
    : { typedValue, adjustedFrom: text };
}
