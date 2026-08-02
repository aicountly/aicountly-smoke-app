import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assembleMasterPrompt,
  caveatFor,
  classifyTrust,
  renderPrefix,
  renderSuffix,
} from './cursorHandoff.js';
import type { UxIssue } from '../reviewer/uxReviewEngine.js';
import type { FeatureGap } from '../reviewer/featureGapEngine.js';

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../samples/prompts');

const context = { run_code: 'RUN-1', product_name: 'HRMS', environment: 'staging', repos: ['hrms-react-app'] };

function ux(overrides: Partial<UxIssue> = {}): UxIssue {
  return {
    category: 'navigation',
    severity: 'low',
    title: 'Breadcrumb missing',
    description: 'No breadcrumb.',
    recommendation: 'Add breadcrumb.',
    human_summary: '',
    developer_prompt: '# Breadcrumb missing\n\nSome prompt body.',
    evidence: {},
    ...overrides,
  };
}

function gap(overrides: Partial<FeatureGap> = {}): FeatureGap {
  return {
    product_name: 'HRMS',
    expected_feature: 'employee directory',
    observed: false,
    partial: false,
    competitor_ref: '',
    severity: 'suggestion',
    confidence: 'low',
    mode: 'implement',
    recommendation: 'Confirm scope.',
    human_summary: '',
    developer_prompt: '# employee directory\n\nSome prompt body.',
    notes: '',
    sources: [],
    evidence: { sample_labels: [], screens_checked: [] },
    ...overrides,
  };
}

test('the shared prefix/suffix/caveat samples exist on disk', () => {
  for (const file of ['cursor-master-prefix.md', 'cursor-master-suffix.md', 'detector-caveats.json']) {
    assert.ok(fs.existsSync(path.join(SAMPLES_DIR, file)), `${file} should exist under samples/prompts`);
  }
});

test('renderPrefix fills every placeholder, leaving no {{ behind', () => {
  const prefix = renderPrefix({ ...context, counts: 'Findings: 1 to verify then fix.' });
  assert.doesNotMatch(prefix, /\{\{/);
  assert.match(prefix, /RUN-1/);
  assert.match(prefix, /hrms-react-app/);
});

test('renderSuffix has no leftover placeholders and states the report-back contract', () => {
  const suffix = renderSuffix();
  assert.doesNotMatch(suffix, /\{\{/);
  assert.match(suffix, /Report back/i);
});

test('caveatFor resolves a category+title specific caveat over the generic one', () => {
  const breadcrumb = caveatFor(ux({ category: 'navigation', title: 'Breadcrumb missing' }));
  assert.match(breadcrumb.detected_by, /breadcrumb/i);

  const search = caveatFor(ux({ category: 'navigation', title: 'Command/search box missing' }));
  assert.match(search.detected_by, /search/i);
  assert.notEqual(search.detected_by, breadcrumb.detected_by);
});

test('caveatFor resolves feature-gap caveats by mode', () => {
  const implement = caveatFor(gap({ mode: 'implement' }));
  assert.match(implement.disprove, /matched_context/i);

  const validateFirst = caveatFor(gap({ mode: 'validate_first' }));
  assert.match(validateFirst.disprove, /scope question|product owner/i);
});

test('classifyTrust: a multi_tenant finding is a likely artifact when the run inventory shows a company/branch/FY label', () => {
  const finding = ux({ category: 'multi_tenant', title: 'Company / branch / FY selector not detected' });
  assert.equal(classifyTrust(finding, ['2026 - 27 | HO']), 'likely_artifact');
  assert.equal(classifyTrust(finding, ['Save changes']), 'verify_then_fix');
});

test('classifyTrust: a search finding is a likely artifact only when both its own title and the run inventory point at search', () => {
  const searchFinding = ux({ category: 'navigation', title: 'Command/search box missing' });
  assert.equal(classifyTrust(searchFinding, ['Search employees, modules…']), 'likely_artifact');
  assert.equal(classifyTrust(searchFinding, ['Add Employee']), 'verify_then_fix');

  const breadcrumbFinding = ux({ category: 'navigation', title: 'Breadcrumb missing' });
  assert.equal(classifyTrust(breadcrumbFinding, ['Search employees, modules…']), 'verify_then_fix');
});

test('classifyTrust: a partial implement-mode feature gap with matched tokens is a likely artifact', () => {
  const partialGap = gap({ mode: 'implement', partial: true, evidence: { sample_labels: [], screens_checked: [], matched_context: ['employee'] } });
  assert.equal(classifyTrust(partialGap), 'likely_artifact');

  const noEvidenceGap = gap({ mode: 'implement', partial: true, evidence: { sample_labels: [], screens_checked: [] } });
  assert.equal(classifyTrust(noEvidenceGap), 'verify_then_fix');
});

test('classifyTrust: a validate_first feature gap is never a build order', () => {
  const finding = gap({ mode: 'validate_first' });
  assert.equal(classifyTrust(finding), 'do_not_build');
});

test('classifyTrust: a filters finding is a likely artifact when search labels or filter/search kinds are present', () => {
  const finding = ux({
    category: 'filters',
    title: 'Data screen without filters',
    evidence: {
      inventory_samples: [{ kind: 'search', label: 'Search employees', selector: 'input' }],
    },
  });
  assert.equal(classifyTrust(finding), 'likely_artifact');
  assert.equal(classifyTrust(ux({ category: 'filters', title: 'Data screen without filters' }), ['Search employees']), 'likely_artifact');
  assert.equal(classifyTrust(ux({ category: 'filters', title: 'Data screen without filters' }), ['Save']), 'verify_then_fix');
});

test('classifyTrust: export findings demote when run labels show Download CSV/Excel/PDF', () => {
  const finding = ux({
    category: 'reports',
    title: 'Export option missing on a screen with a table',
  });
  assert.equal(classifyTrust(finding, ['Download CSV']), 'likely_artifact');
  assert.equal(classifyTrust(finding, ['Download Excel']), 'likely_artifact');
  assert.equal(classifyTrust(finding, ['Export to PDF']), 'likely_artifact');
  assert.equal(classifyTrust(finding, ['Save changes']), 'verify_then_fix');
});

test('classifyTrust: zero-evidence validate_first shift scheduler is do_not_build', () => {
  const finding = gap({
    mode: 'validate_first',
    expected_feature: 'shift scheduler',
    partial: false,
    evidence: { sample_labels: [], screens_checked: [], matched_context: [] },
  });
  assert.equal(classifyTrust(finding), 'do_not_build');
});

test('classifyTrust: high-count CRUD row-action duplicates with accessible-name prompts are likely artifacts', () => {
  const editDup = ux({
    category: 'layout',
    title: 'Duplicate button label "Edit"',
    recommendation: 'Give each control its own accessible name (aria-label / aria-labelledby); keep the shared visible copy.',
    developer_prompt: 'Add a distinct aria-label to each "Edit" control. Do not change the visible row-action copy itself.',
    evidence: { count: 17 },
  });
  assert.equal(classifyTrust(editDup), 'likely_artifact');

  const deactivateDup = ux({
    category: 'layout',
    title: 'Duplicate button label "Deactivate"',
    recommendation: 'Give each control its own accessible name (aria-label).',
    developer_prompt: 'Add a distinct aria-label to each "Deactivate" control.',
    evidence: { count: 17 },
  });
  assert.equal(classifyTrust(deactivateDup), 'likely_artifact');

  // Non-row-action duplicates that still ask for a rename stay in Group A.
  const confirmDup = ux({
    category: 'layout',
    title: 'Duplicate button label "Confirm"',
    recommendation: 'Disambiguate via icon + label or context-specific copy.',
    developer_prompt: 'Rename the duplicate "Confirm" buttons on this screen so each conveys a distinct action.',
    evidence: { count: 5 },
  });
  assert.equal(classifyTrust(confirmDup), 'verify_then_fix');
});

test('assembleMasterPrompt opens with the v1 sentinel and orders groups A, B, C', () => {
  const doc = assembleMasterPrompt({
    context,
    uxIssues: [
      ux({ category: 'multi_tenant', title: 'Company / branch / FY selector not detected', severity: 'low' }),
      ux({ category: 'layout', title: 'Table overflows viewport', severity: 'high' }),
    ],
    featureGaps: [gap({ mode: 'validate_first', expected_feature: 'form 16' })],
    allInventoryLabels: ['2026 - 27 | HO'],
  });

  assert.match(doc, /^<!-- smoke:master-prompt v1 -->/);
  const groupA = doc.indexOf('Group A');
  const groupB = doc.indexOf('Group B');
  const groupC = doc.indexOf('Group C');
  assert.ok(groupA > -1 && groupB > groupA && groupC > groupB, 'groups must appear in trust order A, B, C');
  assert.match(doc, /## Detection & disproof/);
});

test('assembleMasterPrompt with full inventory labels places multi_tenant + search in Group B and validate_first in Group C', () => {
  const doc = assembleMasterPrompt({
    context,
    uxIssues: [
      ux({
        category: 'multi_tenant',
        title: 'Company / branch / FY selector not detected',
        developer_prompt: '# Company / branch / FY selector not detected\n\nBody.',
      }),
      ux({
        category: 'navigation',
        title: 'Command/search box missing',
        developer_prompt: '# Command/search box missing\n\nBody.',
      }),
      ux({
        category: 'layout',
        title: 'Table overflows viewport',
        severity: 'high',
        developer_prompt: '# Table overflows viewport\n\nBody.',
      }),
    ],
    featureGaps: [gap({
      mode: 'validate_first',
      expected_feature: 'form 16',
      developer_prompt: '# form 16\n\nBody.',
    })],
    allInventoryLabels: ['2026 - 27 | HO', 'Search employees, modules…', 'FY 2026-27'],
  });

  // Match the section headings (prefix prose also names the groups).
  const groupA = doc.indexOf('# Group A');
  const groupB = doc.indexOf('# Group B');
  const groupC = doc.indexOf('# Group C');
  assert.ok(groupA > -1 && groupB > groupA && groupC > groupB);

  const sectionA = doc.slice(groupA, groupB);
  const sectionB = doc.slice(groupB, groupC);
  const sectionC = doc.slice(groupC);
  assert.match(sectionA, /Table overflows viewport/);
  assert.match(sectionB, /Company \/ branch \/ FY selector not detected/);
  assert.match(sectionB, /Command\/search box missing/);
  assert.match(sectionC, /# form 16/);
});

test('assembleMasterPrompt renders the prefix exactly once for a multi-finding pack', () => {
  const doc = assembleMasterPrompt({
    context,
    uxIssues: [ux({ title: 'Breadcrumb missing' }), ux({ title: 'Table overflows viewport', category: 'layout' })],
    featureGaps: [],
  });
  const occurrences = doc.split('Master Cursor prompt').length - 1;
  assert.equal(occurrences, 1);
});

test('assembleMasterPrompt drops findings with no developer_prompt body', () => {
  const doc = assembleMasterPrompt({
    context,
    uxIssues: [ux({ developer_prompt: '' })],
    featureGaps: [],
  });
  assert.match(doc, /No findings recorded in this pack\./);
});
