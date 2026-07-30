import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FormFieldDescriptor } from './fieldSynthesis.js';
import {
  applyLastResort,
  brainFieldPayload,
  describePlan,
  fieldKey,
  fieldsNeedingBrain,
  mergeBrainValues,
  planFromHeuristics,
} from './formFillPlan.js';
import { readValues } from './formFillBrain.js';

function field(partial: Partial<FormFieldDescriptor>): FormFieldDescriptor {
  return {
    tag: 'input',
    type: 'text',
    name: '',
    id: '',
    placeholder: '',
    ariaLabel: '',
    label: '',
    required: false,
    ...partial,
  };
}

const NOW = new Date('2026-07-30T00:00:00');

describe('fieldKey', () => {
  it('prefers name, then id, then a described position', () => {
    assert.equal(fieldKey(field({ name: 'comp_name', id: 'x' }), 0), 'comp_name');
    assert.equal(fieldKey(field({ id: 'comp' }), 0), 'comp');
    assert.equal(fieldKey(field({ label: 'Ledger group' }), 3), 'Ledger group#3');
    assert.equal(fieldKey(field({}), 5), 'field#5');
  });
});

describe('planFromHeuristics', () => {
  it('answers what it recognises and marks the rest unresolved', () => {
    const plan = planFromHeuristics(
      [field({ name: 'comp_name' }), field({ name: 'custom_attr_7' })],
      { entityName: 'Smoke Test Co', now: NOW },
    );
    assert.deepEqual(
      plan.map((entry) => [entry.key, entry.value, entry.source]),
      [['comp_name', 'Smoke Test Co', 'heuristic'], ['custom_attr_7', null, 'unresolved']],
    );
  });
});

describe('fieldsNeedingBrain', () => {
  it('asks only about required, unmapped, safe fields', () => {
    const plan = planFromHeuristics([
      field({ name: 'comp_name' }),                       // mapped
      field({ name: 'ledger_group_x' }),                  // unmapped, optional
      field({ name: 'ledger_group_y', required: true }),  // unmapped, required
      field({ name: 'gstin', required: true }),           // unsafe
    ], { now: NOW });
    assert.deepEqual(fieldsNeedingBrain(plan).map((entry) => entry.key), ['ledger_group_y']);
  });
});

describe('mergeBrainValues', () => {
  const plan = () => planFromHeuristics([
    field({ name: 'comp_name' }),
    field({ name: 'ledger_group', required: true }),
    field({ name: 'gstin', required: true }),
  ], { entityName: 'Smoke Test Co', now: NOW });

  it('fills a gap the heuristics left open', () => {
    const merged = mergeBrainValues(plan(), { ledger_group: 'Sundry Debtors' });
    assert.deepEqual(
      merged.map((entry) => [entry.value, entry.source]),
      [['Smoke Test Co', 'heuristic'], ['Sundry Debtors', 'brain'], [null, 'unresolved']],
    );
  });

  it('cannot overrule a value the heuristics already chose', () => {
    const merged = mergeBrainValues(plan(), { comp_name: 'Acme Real Customer Pvt Ltd' });
    assert.equal(merged[0].value, 'Smoke Test Co');
  });

  it('cannot talk the run into inventing a checksum identifier', () => {
    const merged = mergeBrainValues(plan(), { gstin: '29AAAAA0000A1Z5' });
    assert.equal(merged[2].value, null);
  });

  it('rejects prose, placeholders and oversized answers', () => {
    for (const proposed of ['N/A', 'unknown', '', '   ', 'Sorry, I cannot determine this', 'x'.repeat(201)]) {
      const merged = mergeBrainValues(plan(), { ledger_group: proposed });
      assert.equal(merged[1].value, null, proposed.slice(0, 20));
    }
  });

  it('accepts numbers and booleans as text', () => {
    assert.equal(mergeBrainValues(plan(), { ledger_group: 42 })[1].value, '42');
    assert.equal(mergeBrainValues(plan(), { ledger_group: true })[1].value, 'true');
  });

  it('ignores keys for fields that were never offered', () => {
    const merged = mergeBrainValues(plan(), { something_else: 'value' });
    assert.equal(merged.every((entry) => entry.source !== 'brain'), true);
  });
});

describe('applyLastResort', () => {
  it('answers a required field the brain also declined, and leaves optional ones blank', () => {
    const plan = applyLastResort(planFromHeuristics([
      field({ name: 'custom_required', required: true }),
      field({ name: 'custom_optional' }),
      field({ name: 'gstin', required: true }),
    ], { now: NOW }));
    assert.deepEqual(
      plan.map((entry) => [entry.value, entry.source]),
      [['Smoke Test', 'fallback'], [null, 'unresolved'], [null, 'unresolved']],
    );
  });

  it('runs after the brain, so a real answer always wins over the placeholder', () => {
    const heuristic = planFromHeuristics([field({ name: 'ledger_group', required: true })], { now: NOW });
    const plan = applyLastResort(mergeBrainValues(heuristic, { ledger_group: 'Sundry Debtors' }));
    assert.deepEqual([plan[0].value, plan[0].source], ['Sundry Debtors', 'brain']);
  });
});

describe('describePlan', () => {
  it('lists only the fields that will actually be typed', () => {
    const merged = mergeBrainValues(
      planFromHeuristics([field({ name: 'comp_name' }), field({ name: 'custom_x' })], {
        entityName: 'Smoke Test Co',
        now: NOW,
      }),
      {},
    );
    assert.deepEqual(describePlan(merged), ['comp_name=Smoke Test Co']);
  });
});

describe('brainFieldPayload', () => {
  it('sends labels and types, never page content', () => {
    const plan = planFromHeuristics([field({ name: 'ledger_group', label: 'Ledger group', required: true })], {
      now: NOW,
    });
    assert.deepEqual(brainFieldPayload(plan), [{
      key: 'ledger_group',
      tag: 'input',
      type: 'text',
      label: 'Ledger group',
      required: true,
    }]);
  });
});

describe('readValues', () => {
  it('accepts a wrapped map, a bare map, and nothing else', () => {
    assert.deepEqual(readValues({ values: { a: '1' } }), { a: '1' });
    assert.deepEqual(readValues({ a: '1' }), { a: '1' });
    assert.deepEqual(readValues({ note: 'deterministic fallback' }), {});
    assert.deepEqual(readValues(null), {});
    assert.deepEqual(readValues('a string'), {});
    assert.deepEqual(readValues([{ a: '1' }]), {});
  });
});
