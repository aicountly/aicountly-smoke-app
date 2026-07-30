import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autonomousOption, isAutonomouslyAllowed } from './autonomousChoice.js';
import type { DecisionOption } from './askDecision.js';

/** The options resolveAppContext offers when the company picker is empty. */
const EMPTY_PICKER: DecisionOption[] = [
  { id: 'create_company', label: 'Create "Smoke Test Co"', action: 'create_company' },
  { id: 'rescan_menus', label: 'Rescan the company picker', action: 'rescan_menus' },
  { id: 'skip_company_scoped_menus', label: 'Skip company-scoped navigation', action: 'skip_target' },
  { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
];

/** The options runSession offers when a menu click stays blocked. */
const BLOCKED_CLICK: DecisionOption[] = [
  { id: 'dismiss_and_retry', label: 'Dismiss the overlay and rescan menus', action: 'dismiss_overlay' },
  { id: 'skip_control', label: 'Skip "Reports"', action: 'skip_target' },
  { id: 'rescan_menus', label: 'Rescan menus', action: 'rescan_menus' },
  { id: 'abort_session', label: 'Abort this session', action: 'abort_session' },
];

describe('isAutonomouslyAllowed', () => {
  it('never lets the run end a session by itself', () => {
    for (const environment of ['sandbox', 'production_full_access', 'production_restricted']) {
      assert.equal(isAutonomouslyAllowed(environment, 'abort_session'), false, environment);
    }
  });

  it('only creates a company where mutations are already permitted', () => {
    assert.equal(isAutonomouslyAllowed('sandbox', 'create_company'), true);
    assert.equal(isAutonomouslyAllowed('gh_staging', 'create_company'), true);
    assert.equal(isAutonomouslyAllowed('production_full_access', 'create_company'), true);
    assert.equal(isAutonomouslyAllowed('production_restricted', 'create_company'), false);
    assert.equal(isAutonomouslyAllowed('production_readonly', 'create_company'), false);
  });

  it('leaves navigation actions open everywhere', () => {
    for (const action of ['skip_target', 'rescan_menus', 'dismiss_overlay', 'navigate_href'] as const) {
      assert.equal(isAutonomouslyAllowed('production_readonly', action), true, action);
    }
  });
});

describe('autonomousOption', () => {
  it('takes the recommendation when this target permits it', () => {
    const choice = autonomousOption('production_full_access', EMPTY_PICKER, 'create_company');
    assert.equal(choice?.id, 'create_company');
  });

  it('skips company-scoped menus rather than attempting a create it cannot do', () => {
    const choice = autonomousOption('production_restricted', EMPTY_PICKER, 'create_company');
    assert.equal(choice?.id, 'skip_company_scoped_menus');
  });

  it('prefers clearing the obstacle over skipping a blocked control', () => {
    assert.equal(autonomousOption('sandbox', BLOCKED_CLICK, undefined)?.id, 'dismiss_and_retry');
  });

  it('never returns abort, even as the only remaining option', () => {
    const onlyAbort: DecisionOption[] = [{ id: 'abort_session', label: 'Abort', action: 'abort_session' }];
    assert.equal(autonomousOption('sandbox', onlyAbort, 'abort_session'), null);
  });

  it('ignores a recommendation that is not on offer', () => {
    const choice = autonomousOption('sandbox', BLOCKED_CLICK, 'something_else');
    assert.equal(choice?.id, 'dismiss_and_retry');
  });
});
