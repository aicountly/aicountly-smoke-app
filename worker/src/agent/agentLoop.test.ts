import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionTriple,
  CIRCLING_WINDOW,
  evaluateBlockedDecision,
  evaluateLoopDetection,
  evaluateNavigationCircling,
  formIdentityKey,
  isAwaitingVerification,
  markVerifiedByPageText,
  parseAgentAction,
  parseFillEntries,
  recentFieldValues,
  submittedControls,
  visitedScreens,
  type CreatedRecord,
} from './agentLoop.js';
import type { AgentStepRecord } from './actions.js';
import type { MarkDescriptor } from './marks.js';
import { signatureKey, type PageSignature } from './perceive.js';

function sig(overrides: Partial<PageSignature> = {}): PageSignature {
  return {
    url: 'https://app.test/',
    title: 'Home',
    markCount: 2,
    domHash: 'a',
    formHash: 'f',
    dialogCount: 0,
    scrollY: 0,
    ...overrides,
  };
}

function mark(overrides: Partial<MarkDescriptor> = {}): MarkDescriptor {
  return {
    mark: 1,
    tag: 'input',
    role: '',
    name: 'Field',
    type: 'text',
    value: '',
    checked: null,
    disabled: false,
    offscreen: false,
    viewport_offset: 0,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function step(overrides: Partial<AgentStepRecord> = {}): AgentStepRecord {
  return {
    ordinal: 1,
    captured_at: '2026-07-30T00:00:00.000Z',
    screenshot: '',
    observation: '',
    reasoning: '',
    goal_progress: '',
    blockers: [],
    action: { type: 'click', mark: 28 },
    outcome: 'executed',
    outcome_observation: '',
    guard: { allowed: true },
    target_label: 'Create employee master',
    signature_before: sig(),
    signature_after: sig(),
    signature_changed: true,
    ...overrides,
  };
}

test('parses Set-of-Marks actions without selectors', () => {
  assert.deepEqual(parseAgentAction({ type: 'click', mark: 7 }), { type: 'click', mark: 7 });
  assert.deepEqual(
    parseAgentAction({ type: 'type', mark: 2, text: 'Smoke Co', submit: true }),
    { type: 'type', mark: 2, text: 'Smoke Co', submit: true },
  );
  assert.throws(() => parseAgentAction({ type: 'click', mark: 0 }), /Invalid Set-of-Marks/);
  assert.throws(() => parseAgentAction({ type: 'click', selector: '#save' }), /Invalid Set-of-Marks/);
});

test('a batch fill parses into typed and chosen fields', () => {
  assert.deepEqual(
    parseAgentAction({
      type: 'fill_form',
      fields: [{ mark: 2, value: 'SMOKE-Anita' }, { mark: 5, option: 'Permanent' }],
    }),
    { type: 'fill_form', fields: [{ mark: 2, value: 'SMOKE-Anita' }, { mark: 5, option: 'Permanent' }] },
  );
});

test('a batch fill accepts the field aliases models reach for', () => {
  assert.deepEqual(
    parseFillEntries([{ mark: 2, text: 'SMOKE-Anita' }, { mark: 5, label: 'Permanent' }]),
    [{ mark: 2, value: 'SMOKE-Anita' }, { mark: 5, option: 'Permanent' }],
  );
  // A blank option is not a choice, so the value alongside it is used instead.
  assert.deepEqual(parseFillEntries([{ mark: 3, option: '  ', value: '42' }]), [{ mark: 3, value: '42' }]);
});

test('a batch fill with no usable fields is rejected outright', () => {
  assert.throws(() => parseAgentAction({ type: 'fill_form', fields: [] }), /non-empty/);
  assert.throws(() => parseAgentAction({ type: 'fill_form' }), /non-empty/);
  assert.throws(() => parseFillEntries([{ value: 'x' }]), /Invalid Set-of-Marks/);
});

test('page signature key changes on dialogs and DOM/form changes, but not on scroll alone', () => {
  const base = sig();
  assert.notEqual(signatureKey(base), signatureKey(sig({ dialogCount: 1 })));
  assert.notEqual(signatureKey(base), signatureKey(sig({ domHash: 'b' })));
  // formHash is what makes typing into a field count as progress.
  assert.notEqual(signatureKey(base), signatureKey(sig({ formHash: 'g' })));
  // Scrolling is not progress: a scroll must not look like a changed screen, or
  // loop detection never penalises scroll thrash and a legitimate scroll never
  // gets credit for "unchanged" either way.
  assert.equal(signatureKey(base), signatureKey(sig({ scrollY: 800 })));
  assert.equal(signatureKey(base), signatureKey(sig()));
});

test('actionTriple keys on DOM signature, not only the URL', () => {
  const a = sig({ url: 'https://hrms.test/employees', title: 'List', markCount: 4, domHash: 'aaa' });
  const b = sig({ url: 'https://hrms.test/employees', title: 'Form', markCount: 8, domHash: 'bbb' });
  const action = { type: 'click' as const, mark: 12 };
  assert.notEqual(actionTriple(action, a), actionTriple(action, b));
});

test('repeated action that changes the screen is not a loop warning', () => {
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = sig({ title: 'A', markCount: 1, domHash: '1' });
  const action = { type: 'click' as const, mark: 3 };

  for (let i = 0; i < 6; i += 1) {
    const before = { ...prior };
    const after: PageSignature = { ...prior, domHash: `h${i}`, title: `T${i}` };
    const next = evaluateLoopDetection({
      action,
      before,
      after,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
    });
    assert.equal(next.warned, false, `iteration ${i} should not warn on progressing screens`);
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
  }
  assert.equal(recentTriples.length, 0);
});

test('form identity key stays stable as empty fields shrink', () => {
  const page = sig({ url: 'https://hrms.test/employees/new', title: 'Add Employee', markCount: 5, domHash: 'before' });
  const marks = (values: string[]): MarkDescriptor[] => ([
    mark({ mark: 1, name: 'First name', value: values[0] ?? '' }),
    mark({ mark: 2, name: 'Last name', value: values[1] ?? '' }),
    mark({ mark: 3, tag: 'select', name: 'Department', type: '', value: values[2] ?? '' }),
    mark({ mark: 4, tag: 'button', role: 'button', name: 'Save', type: 'submit' }),
  ]);
  const empty = formIdentityKey(page, marks(['', '', '']));
  const filled = formIdentityKey(
    { ...page, domHash: 'after-typing' },
    marks(['SMOKE-Ada', 'SMOKE-Lovelace', 'Engineering']),
  );
  assert.equal(empty, filled);
});

test('five identical stalled actions warn; fewer do not', () => {
  const stuck = sig({ title: 'Stuck', domHash: 'same' });
  const action = { type: 'click' as const, mark: 9 };
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;

  for (let i = 1; i <= 5; i += 1) {
    const next = evaluateLoopDetection({
      action,
      before: stuck,
      after: stuck,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
    });
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
    if (i < 5) assert.equal(next.warned, false, `should not warn at stall ${i}`);
  }
  assert.equal(warnedAt, 5);
});

test('type/select on an unchanging screen does not increment the unchanged counter', () => {
  const stuck = sig({ title: 'Form', domHash: 'same', formHash: 'same' });
  let unchangedCount = 0;
  let prior = stuck;

  for (let i = 1; i <= 8; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'type', mark: 4, text: 'SMOKE-value' },
      before: stuck,
      after: stuck,
      recentTriples: [],
      unchangedCount,
      priorSignature: prior,
    });
    assert.equal(next.warned, false, `type should never trip the unchanged counter (iteration ${i})`);
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
  }
  assert.equal(unchangedCount, 0);

  // A select action on the same unchanging screen is exempt the same way.
  const afterSelect = evaluateLoopDetection({
    action: { type: 'select', mark: 5, option: 'Engineering' },
    before: stuck,
    after: stuck,
    recentTriples: [],
    unchangedCount: 0,
    priorSignature: prior,
  });
  assert.equal(afterSelect.unchangedCount, 0);
  assert.equal(afterSelect.warned, false);

  // A whole form filled in one action is exempt on the same grounds.
  const afterBatch = evaluateLoopDetection({
    action: { type: 'fill_form', fields: [{ mark: 4, value: 'SMOKE-value' }] },
    before: stuck,
    after: stuck,
    recentTriples: [],
    unchangedCount: 0,
    priorSignature: prior,
  });
  assert.equal(afterBatch.unchangedCount, 0);
  assert.equal(afterBatch.warned, false);
});

test('an ordinary click on an unchanging screen still counts toward the unchanged counter', () => {
  const stuck = sig({ title: 'Form', domHash: 'same', formHash: 'same' });
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;
  for (let i = 1; i <= 6; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'click', mark: 4 },
      before: stuck,
      after: stuck,
      recentTriples: [],
      unchangedCount,
      priorSignature: prior,
    });
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
  }
  assert.equal(warnedAt, 6);
});

test('a run of four or more scrolls warns even though the screen keeps "changing" scroll position', () => {
  const stuck = sig({ title: 'Long page', domHash: 'same', formHash: 'same' });
  let recentTriples: string[] = [];
  let unchangedCount = 0;
  let prior = stuck;
  let warnedAt = 0;

  for (let i = 1; i <= 4; i += 1) {
    const next = evaluateLoopDetection({
      action: { type: 'scroll', direction: 'down', amount: 700 },
      before: stuck,
      after: stuck,
      recentTriples,
      unchangedCount,
      priorSignature: prior,
      consecutiveScrolls: i,
    });
    recentTriples = next.recentTriples;
    unchangedCount = next.unchangedCount;
    prior = next.priorSignature;
    if (next.warned) warnedAt = i;
    if (i < 4) assert.equal(next.warned, false, `should not warn on scroll ${i}`);
  }
  assert.equal(warnedAt, 4);
});

test('only successful clicks on save-style controls count as submitted', () => {
  const found = submittedControls([
    step({ ordinal: 19 }),
    step({ ordinal: 20, target_label: 'Cancel' }),
    step({ ordinal: 21, outcome: 'refused' }),
    step({ ordinal: 24 }),
    step({ ordinal: 25, action: { type: 'type', mark: 21, text: '9876543210' }, target_label: 'Create employee master' }),
  ]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { mark: 28, label: 'Create employee master', step: 19 });
});

test('a control that only opens a create form is not a submit', () => {
  // "ADD COMPANY Create New Company" opens the form. Reading it as a submit told
  // the model, via session_facts, that a company had already been created, so it
  // never filled the form at all.
  for (const label of ['ADD COMPANY Create New Company', '+ Add New Branch', 'New Employee']) {
    assert.deepEqual(submittedControls([step({ target_label: label })]), [], label);
  }
  assert.equal(submittedControls([step({ target_label: 'Create employee master' })]).length, 1);
  assert.equal(submittedControls([step({ target_label: 'Save' })]).length, 1);
});

test('a create is only awaiting verification once distinctive values were typed', () => {
  const record = (values: Record<string, string>): CreatedRecord => ({
    url: 'https://hrms.test/company/new',
    formKey: 'k',
    values,
    verifiedInList: false,
  });
  // A submit click with nothing typed cannot have created anything, so there is
  // nothing to look for and nothing to claim.
  assert.equal(isAwaitingVerification(record({})), false);
  assert.equal(isAwaitingVerification(record({ 'PIN code': '560001' })), false);
  assert.equal(isAwaitingVerification(record({ Name: 'SMOKE-Acme Traders' })), true);
});

test('a create is verified by its own value showing up on a later screen', () => {
  const records: CreatedRecord[] = [{
    url: 'https://hrms.test/company/new',
    formKey: 'k',
    values: { Name: 'SMOKE-Acme Traders' },
    verifiedInList: false,
  }];

  markVerifiedByPageText(records, 'All companies (2)\nSmoke Test Co\nNothing else here');
  assert.equal(records[0]!.verifiedInList, false);

  markVerifiedByPageText(records, 'All companies (3)\nSMOKE-Acme Traders\nSmoke Test Co');
  assert.equal(records[0]!.verifiedInList, true);
});

test('visited screens carry their visit counts, most-visited first', () => {
  const landing = (title: string, url: string) => step({
    signature_after: sig({ title, url }),
  });
  const visited = visitedScreens([
    landing('Dashboard', 'https://hrms.test/'),
    landing('Invitations', 'https://hrms.test/invitations'),
    landing('Dashboard', 'https://hrms.test/'),
    landing('Companies', 'https://hrms.test/companies'),
    landing('Dashboard', 'https://hrms.test/'),
    step({ outcome: 'refused', signature_after: sig({ title: 'Never counted', url: 'https://hrms.test/x' }) }),
  ]);
  assert.deepEqual(visited[0], { title: 'Dashboard', url: 'https://hrms.test/', visits: 3 });
  assert.equal(visited.length, 3);
});

/** A sidebar hop: a click that lands on an already-known destination. */
function hop(ordinal: number, title: string): AgentStepRecord {
  return step({
    ordinal,
    target_label: title,
    signature_after: sig({ title, url: `https://hrms.test/${title.toLowerCase()}`, domHash: title }),
  });
}

test('re-walking a menu already covered is circling, even though every click changes the screen', () => {
  const sweep = ['Dashboard', 'Invitations', 'Companies', 'Branches', 'Financial Years', 'Key Persons'];
  const first = sweep.map((title, index) => hop(index + 1, title));
  assert.equal(evaluateNavigationCircling({ steps: first }).circling, false);

  const second = sweep.map((title, index) => hop(first.length + index + 1, title));
  const verdict = evaluateNavigationCircling({ steps: [...first, ...second] });
  assert.equal(verdict.circling, true);
  assert.deepEqual(verdict.revisited, sweep);
  assert.equal(second.length, CIRCLING_WINDOW);
});

test('a sweep that opens a screen never seen before is not circling', () => {
  const first = ['Dashboard', 'Invitations', 'Companies', 'Branches', 'Financial Years', 'Key Persons']
    .map((title, index) => hop(index + 1, title));
  const second = ['Dashboard', 'Invitations', 'Companies', 'Branches', 'Financial Years', 'Print Assets']
    .map((title, index) => hop(first.length + index + 1, title));
  assert.equal(evaluateNavigationCircling({ steps: [...first, ...second] }).circling, false);
});

test('revisiting a list to check a record just saved is not circling', () => {
  const first = ['Dashboard', 'Invitations', 'Companies', 'Branches', 'Financial Years', 'Key Persons']
    .map((title, index) => hop(index + 1, title));
  const second = ['Dashboard', 'Invitations', 'Companies', 'Branches', 'Financial Years']
    .map((title, index) => hop(first.length + index + 1, title));
  const withWork = [
    ...first,
    ...second,
    step({
      ordinal: 12,
      action: { type: 'type', mark: 4, text: 'SMOKE-Acme' },
      target_label: 'Company name',
      signature_after: sig({ title: 'Dashboard', url: 'https://hrms.test/dashboard' }),
    }),
  ];
  assert.equal(evaluateNavigationCircling({ steps: withWork }).circling, false);
});

test('blocked is refused once when the session already submitted that control', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 0, maxY: 0, deepestSeen: 0 };

  const first = evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 0, reason: 'I cannot find any create control.' });
  assert.match(String(first), /Create employee master/);
  assert.match(String(first), /offscreen/);
  // Second time the agent insists, the run has to let it go or it never ends.
  assert.equal(
    evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 1, reason: 'I cannot find any create control.' }),
    null,
  );
});

test('blocked is accepted even after a submit when the model already admits the control was used', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 900, maxY: 900, deepestSeen: 900 };

  // "The record I just saved does not appear in the list" is a plausible product
  // bug (list not refetching after save), not a false "no such control" claim —
  // it must not be refuted just because a submit control was clicked this session.
  for (const reason of [
    'The new leave type does not appear in the list after saving.',
    'Saved record is missing from the list.',
    'The employee is not shown in the list view.',
  ]) {
    assert.equal(
      evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 0, reason }),
      null,
      reason,
    );
  }
});

test('blocked is accepted after a submit when the reason names a server-side refusal', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 900, maxY: 900, deepestSeen: 900 };

  // The submit control was found and clicked; the target rejected it. That is
  // not a "cannot find the control" claim, so it must not be sent back to
  // scroll-and-retry against an error that scrolling cannot fix.
  for (const reason of [
    'The engagement was not created: Insufficient permissions.',
    'Save failed with "Permission denied" from the server.',
    'The request was rejected: 403 Forbidden.',
    'Create failed with a 500 server error.',
    'The user is not authorized to perform this action.',
  ]) {
    assert.equal(
      evaluateBlockedDecision({ steps, submitted, scroll, refusalsUsed: 0, reason }),
      null,
      reason,
    );
  }
});

test('blocked still refutes a missing-control claim even when it mentions an unrelated status-shaped number', () => {
  const steps = [step({ ordinal: 19 })];
  const submitted = submittedControls(steps);
  const scroll = { y: 900, maxY: 900, deepestSeen: 900 };

  const refutation = evaluateBlockedDecision({
    steps,
    submitted,
    scroll,
    refusalsUsed: 0,
    reason: 'I cannot find any create control on this screen.',
  });
  assert.match(String(refutation), /Create employee master/);
});

test('blocked is refused when part of the page was never scrolled into view', () => {
  const refutation = evaluateBlockedDecision({
    steps: [],
    submitted: [],
    scroll: { y: 0, maxY: 1400, deepestSeen: 0 },
    refusalsUsed: 0,
    reason: 'I cannot find a create control anywhere on this screen.',
  });
  assert.match(String(refutation), /1400px/);
});

test('blocked is accepted when nothing was submitted and the page was fully seen', () => {
  assert.equal(
    evaluateBlockedDecision({
      steps: [],
      submitted: [],
      scroll: { y: 900, maxY: 900, deepestSeen: 900 },
      refusalsUsed: 0,
      reason: 'No create control exists on this screen.',
    }),
    null,
  );
});

const FORM_URL = 'https://app.test/employees/new';

test('a form filled in one batch still feeds the created-record ledger', () => {
  const values = recentFieldValues([
    step({
      action: {
        type: 'fill_form',
        fields: [{ mark: 2, value: 'Anita' }, { mark: 5, option: 'Permanent' }, { mark: 9, value: 'x' }],
      },
      // The batch's own label counts fields; the per-field results carry the names.
      target_label: '2 of 3 fields',
      fill_results: [
        { mark: 2, label: 'First name', status: 'filled', value: 'SMOKE-Anita' },
        { mark: 5, label: 'Employment type', status: 'chosen', value: 'Permanent' },
        { mark: 9, label: 'PAN', status: 'refused', reason: 'statutory identifier' },
      ],
      signature_before: sig({ url: FORM_URL }),
      signature_after: sig({ url: FORM_URL }),
    }),
  ], FORM_URL);

  assert.deepEqual(values, { 'First name': 'SMOKE-Anita', 'Employment type': 'Permanent' });
});

test('a batch on a different screen does not count toward this form', () => {
  const values = recentFieldValues([
    step({
      action: { type: 'fill_form', fields: [{ mark: 2, value: 'Anita' }] },
      fill_results: [{ mark: 2, label: 'Search', status: 'filled', value: 'SMOKE-Anita' }],
      signature_before: sig({ url: 'https://app.test/elsewhere' }),
      signature_after: sig({ url: 'https://app.test/elsewhere' }),
    }),
  ], FORM_URL);

  assert.deepEqual(values, {});
});

test('single fills and batch fills on the same form are collected together', () => {
  const values = recentFieldValues([
    step({
      action: { type: 'fill_form', fields: [{ mark: 2, value: 'Anita' }] },
      fill_results: [{ mark: 2, label: 'First name', status: 'filled', value: 'SMOKE-Anita' }],
      signature_before: sig({ url: FORM_URL }),
      signature_after: sig({ url: FORM_URL }),
    }),
    step({
      action: { type: 'type', mark: 7, text: 'SMOKE-E1' },
      target_label: 'Employee code',
      typed_value: 'SMOKE-E1',
      signature_before: sig({ url: FORM_URL }),
      signature_after: sig({ url: FORM_URL }),
    }),
  ], FORM_URL);

  assert.deepEqual(values, { 'First name': 'SMOKE-Anita', 'Employee code': 'SMOKE-E1' });
});
