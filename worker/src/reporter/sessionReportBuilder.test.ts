import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileIoStatusLabel, renderSessionHtml } from './sessionReportBuilder.js';

test('session HTML keeps recommendations readable and links visual evidence', () => {
  const html = renderSessionHtml({
    run_code: 'RUN-42',
    session_name: 'Attendance',
    menu_path: '/attendance',
    product_name: 'HRMS',
    environment: 'staging',
    status: 'done',
    screens_observed: 1,
    inventory_count: 2,
    severity_summary: { critical: 0, high: 1, medium: 0, low: 0, suggestion: 1 },
    ux_issues: [{
      category: 'layout',
      severity: 'high',
      title: 'Table overflows viewport',
      description: 'The table is too wide.',
      recommendation: 'Keep the table inside the viewport.',
      human_summary: 'People cannot read the full table.\n\n- [ ] Make it responsive.',
      developer_prompt: '# Technical implementation',
      evidence: {
        affected_urls: ['/attendance'],
        screenshot_paths: ['/missing/screenshot.png'],
        inventory_samples: [{ label: 'Attendance table', selector: '#attendance-grid' }],
      },
    }],
    feature_gaps: [{
      product_name: 'HRMS',
      expected_feature: 'form 16',
      observed: false,
      partial: false,
      competitor_ref: 'Competitor',
      severity: 'suggestion',
      confidence: 'low',
      mode: 'validate_first',
      recommendation: 'Confirm scope.',
      human_summary: 'Validate whether this belongs in the module.',
      developer_prompt: '# Validation instructions',
      notes: '',
      sources: [],
      evidence: {
        sample_labels: ['Payroll'],
        screens_checked: ['/attendance'],
        target_selectors: ['#payroll-menu'],
      },
    }],
    file_io_tests: [],
    screenshot_data_uris: [],
    cursor_prompts: '# Prompt pack',
    generated_at: '2026-07-29T00:00:00.000Z',
  });

  assert.match(html, /Decisions taken/);
  assert.match(html, /What to fix now/);
  assert.match(html, /People cannot read the full table/);
  assert.match(html, /<details><summary>Developer prompt<\/summary>/);
  assert.match(html, /Visual mockup/);
  assert.match(html, /#attendance-grid/);
  assert.match(html, /class="ribbon">Validate first/);
});

test('sample report templates retain readability contract markers', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const session = fs.readFileSync(path.join(root, 'samples/reports/session.html.tpl'), 'utf8');
  const final = fs.readFileSync(path.join(root, 'samples/reports/final.html.tpl'), 'utf8');

  for (const template of [session, final]) {
    assert.match(template, /Decisions taken/);
    assert.match(template, /display_recommendation/);
    assert.match(template, /evidence_image_data_uri/);
    assert.match(template, /Validate first/);
    assert.match(template, /Visual (mockup|callout)/);
    assert.match(template, /File I\/O tests/);
    assert.match(template, /Export quality vs competitors/);
  }
});

test('upload-only File I/O results render as successful non-comparable workflows', () => {
  assert.equal(fileIoStatusLabel({
    compare_status: 'not_applicable',
    upload_ok: true,
  }), 'Workflow passed (not comparable)');
});
