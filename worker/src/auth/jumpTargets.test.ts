import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJumpPlan, pickJumpTarget, productJumpTargets, type JumpOption } from './jumpTargets.js';

/** Dropdown order copied from my.aicountly.com: Smart Books sits above HRMS. */
const LIVE_OPTIONS: JumpOption[] = [
  { value: '', label: 'Select Jump To' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'books', label: 'Smart Books' },
  { value: 'auditor', label: 'Auditor' },
  { value: 'fr', label: 'Financial Reporting' },
  { value: 'hrms', label: 'HRMS' },
  { value: 'ourpeople', label: 'Our People' },
];

function pickFor(product: string, options = LIVE_OPTIONS, env: NodeJS.ProcessEnv = {}) {
  return pickJumpTarget(options, buildJumpPlan(product, env));
}

test('HRMS is picked even though Smart Books appears earlier in the dropdown', () => {
  const pick = pickFor('hrms');
  assert.equal(pick?.option.value, 'hrms');
  assert.equal(pick?.source, 'preferred');
  assert.equal(pick?.matchedPreference, 'HRMS');
});

test('each product maps to its own Jump To option', () => {
  assert.equal(pickFor('books')?.option.value, 'books');
  assert.equal(pickFor('auditor')?.option.value, 'auditor');
  assert.equal(pickFor('fr')?.option.value, 'fr');
  assert.equal(pickFor('contacts')?.option.value, 'contacts');
  assert.equal(pickFor('ourpeople')?.option.value, 'ourpeople');
});

test('Our People falls back to HRMS only when no ESS option exists', () => {
  const options = LIVE_OPTIONS.filter((o) => o.value !== 'ourpeople');
  const pick = pickFor('ourpeople', options);
  assert.equal(pick?.option.value, 'hrms');
  assert.equal(pick?.source, 'preferred');
});

test('non-books products never fall back to the Books/ERP option', () => {
  const options: JumpOption[] = [
    { value: '', label: 'Select Jump To' },
    { value: 'books', label: 'Smart Books' },
    { value: 'erp', label: 'ERP' },
  ];
  const plan = buildJumpPlan('secretarial', {});
  assert.equal(plan.booksFamily, false);
  assert.ok(!plan.preferred.some((p) => /books|erp/i.test(p)));
  // Nothing matched: the host guard, not a Books guess, decides the outcome.
  assert.equal(pickJumpTarget(options, plan)?.source, 'first_option');
});

test('books-family products keep the Books/ERP fallback', () => {
  const options: JumpOption[] = [
    { value: '', label: 'Select Jump To' },
    { value: 'erp3', label: 'ERP 3.0' },
  ];
  const plan = buildJumpPlan('accounting', {});
  assert.equal(plan.booksFamily, true);
  const pick = pickJumpTarget(options, plan);
  assert.equal(pick?.option.value, 'erp3');
  assert.equal(pick?.source, 'preferred');
});

test('a global SMOKE_JUMP_TO cannot hijack a mapped product', () => {
  const plan = buildJumpPlan('hrms', { SMOKE_JUMP_TO: 'Smart Books' });
  assert.equal(plan.preferred[0], 'HRMS');
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /SMOKE_JUMP_TO/);
  assert.equal(pickJumpTarget(LIVE_OPTIONS, plan)?.option.value, 'hrms');
});

test('a product-scoped SMOKE_JUMP_TO_<PRODUCT> override wins', () => {
  const plan = buildJumpPlan('hrms', { SMOKE_JUMP_TO_HRMS: 'Our People' });
  assert.equal(plan.preferred[0], 'Our People');
  assert.equal(pickJumpTarget(LIVE_OPTIONS, plan)?.option.value, 'ourpeople');
});

test('unknown products try their own name before any fallback', () => {
  const plan = buildJumpPlan('vault', {});
  assert.deepEqual(productJumpTargets('vault'), ['Vault']);
  const pick = pickJumpTarget([...LIVE_OPTIONS, { value: 'vault', label: 'Vault' }], plan);
  assert.equal(pick?.option.value, 'vault');
});

test('placeholder options are never selectable', () => {
  const pick = pickJumpTarget(
    [{ value: '', label: 'Select Jump To' }, { value: '--', label: '--' }],
    buildJumpPlan('hrms', {}),
  );
  assert.equal(pick, null);
});

test('short preferences match whole tokens only', () => {
  const options: JumpOption[] = [{ value: 'frontdesk', label: 'Front Desk' }];
  const pick = pickJumpTarget(options, buildJumpPlan('fr', {}));
  assert.equal(pick?.source, 'first_option');
});
