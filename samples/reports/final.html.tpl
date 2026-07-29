<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{run_code}} - Final Consolidated Report</title>
  <style>
    body { font: 14px/1.55 Inter, system-ui, sans-serif; color: #0f172a; background: #f8fafc; margin: 0; padding: 32px; }
    main { max-width: 1100px; margin: auto; }
    h1 { color: #10B981; margin: 0 0 4px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0 32px; }
    .card, .finding { border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px; background: #fff; position: relative; }
    .card .l { font-size: 12px; color: #64748b; }
    .card .v { font-size: 28px; font-weight: 600; margin-top: 4px; color: #064E3B; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 13px; }
    th { background: #f8fafc; }
    .scorebar { width: 100%; height: 8px; border-radius: 999px; background: #f1f5f9; overflow: hidden; }
    .scorebar > div { height: 100%; background: linear-gradient(90deg, #34D399, #10B981); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    .b-critical { background: #fee2e2; color: #7f1d1d; }
    .b-high     { background: #fef3c7; color: #78350f; }
    .b-medium   { background: #e0f2fe; color: #0c4a6e; }
    .b-low { background: #ecfdf5; color: #065f46; }
    .b-suggestion { background: #f1f5f9; color: #334155; }
    .b-memory { background: #ede9fe; color: #5b21b6; }
    .b-user { background: #dbeafe; color: #1e3a8a; }
    .b-timeout { background: #fee2e2; color: #7f1d1d; }
    .b-cancelled { background: #f1f5f9; color: #334155; }
    .findings { display: grid; gap: 16px; }
    .finding h3 { margin: 5px 0; }
    .human-summary { white-space: pre-wrap; }
    .visual { display: grid; grid-template-columns: minmax(180px, 320px) 1fr; gap: 14px; align-items: start; margin-top: 12px; padding: 12px; border-left: 4px solid #10b981; background: #f0fdf4; border-radius: 8px; }
    .visual img { display: block; width: 100%; border: 1px solid #cbd5e1; border-radius: 7px; }
    .visual p { margin: 3px 0; overflow-wrap: anywhere; }
    .ribbon { position: absolute; right: 0; top: 0; padding: 5px 12px; border-radius: 0 12px 0 10px; background: #fef3c7; color: #92400e; font-weight: 700; }
    details { margin-top: 14px; }
    summary { cursor: pointer; font-weight: 650; }
    .footer { color: #94a3b8; font-size: 11px; margin-top: 48px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 14px; }
    @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, 1fr); } .visual { grid-template-columns: 1fr; } }
  </style>
</head>
<body><main>
  <h1>{{run_code}} &mdash; Final Consolidated Report</h1>
  <div class="meta">
    <strong>Product:</strong> {{product_name}} &nbsp;
    <strong>Environment:</strong> {{environment}} &nbsp;
    <strong>Sessions:</strong> {{sessions_total}} (done {{sessions_done}}, failed {{sessions_failed}})<br>
    <strong>Maturity Score:</strong> {{maturity_score}}/100 &nbsp;
    <strong>UX Score:</strong> {{ux_score}}/100
  </div>

  <div class="grid">
    <div class="card"><div class="l">Screens observed</div><div class="v">{{totals.screens}}</div></div>
    <div class="card"><div class="l">UI inventory</div><div class="v">{{totals.inventory}}</div></div>
    <div class="card"><div class="l">UX issues</div><div class="v">{{totals.ux}}</div></div>
    <div class="card"><div class="l">Feature gaps</div><div class="v">{{totals.gaps}}</div></div>
    <div class="card"><div class="l">File I/O tests</div><div class="v">{{totals.file_io}}</div></div>
    <div class="card"><div class="l">Critical</div><div class="v">{{severity_summary.critical}}</div></div>
    <div class="card"><div class="l">High</div><div class="v">{{severity_summary.high}}</div></div>
    <div class="card"><div class="l">Medium</div><div class="v">{{severity_summary.medium}}</div></div>
    <div class="card"><div class="l">Low</div><div class="v">{{severity_summary.low}}</div></div>
  </div>

  <h2>File I/O tests</h2>
  <p class="meta">Functional fidelity pass rate: <strong>{{file_io_pass_rate}}%</strong></p>
  <table><thead><tr><th>Scenario</th><th>Direction</th><th>Result</th><th>AI quality</th><th>Verdict</th></tr></thead>
  <tbody>{{#file_io_tests}}<tr><td>{{scenario_key}}</td><td>{{direction}}</td><td>{{status_label}}</td><td>{{ai_overall}}</td><td>{{ai_verdict}}</td></tr>{{/file_io_tests}}
  {{^file_io_tests}}<tr><td colspan="5">No File I/O tests ran.</td></tr>{{/file_io_tests}}</tbody></table>
  <h2>Export quality vs competitors</h2>
  <div class="findings">{{#low_file_quality}}<article class="finding"><h3>{{scenario_key}} ({{ai_overall}}/100)</h3><p>{{ai_verdict}}</p></article>{{/low_file_quality}}
  {{^low_file_quality}}<div class="card">No low export-quality scores recorded.</div>{{/low_file_quality}}</div>

  <h2>Decisions taken</h2>
  <p class="meta">Mid-run choices that steered navigation, including remembered answers reused without pausing.</p>
  <div class="findings">
    {{#decisions}}<article class="finding">
      <span class="badge b-{{source}}">{{source_label}}</span>
      <h3>{{situation_label}}</h3>
      <p class="human-summary"><strong>Question:</strong> {{question}}</p>
      <p><strong>Chosen:</strong> {{chosen_label}}</p>
      <p class="meta">Remember for later: {{remember_label}}{{#has_note}} &middot; Note: {{free_text}}{{/has_note}}{{#answered_at}} &middot; {{answered_at}}{{/answered_at}}</p>
      <section class="visual">
        <div>{{#has_screenshot}}<img src="{{image_data_uri}}" alt="Decision screenshot for {{situation_label}}">{{/has_screenshot}}{{^has_screenshot}}Screenshot unavailable for this decision.{{/has_screenshot}}</div>
        <div><strong>Context</strong><p><b>Screen:</b> {{context_title}}</p><p><b>URL:</b> {{context_url}}</p></div>
      </section>
    </article>{{/decisions}}
    {{^decisions}}<div class="card">No mid-run decisions were required for this run.</div>{{/decisions}}
  </div>

  <h2>Top Issues With Visual Evidence</h2>
  <p class="meta">The most urgent UX problems and high-confidence missing features, each paired with a representative observed screen when available.</p>
  <div class="findings">
    {{#top_issues_with_visual_evidence}}<article class="finding">
      <span class="badge b-{{severity}}">{{severity}}</span>
      <h3>{{title}}</h3><div class="meta">{{finding_type}}</div>
      <p class="human-summary"><strong>Recommendation:</strong> {{display_recommendation}}</p>
      {{#has_technical_recommendation}}<details><summary>Technical recommendation</summary><p>{{technical_recommendation}}</p></details>{{/has_technical_recommendation}}
      <section class="visual">
        <div>{{#has_evidence_image}}<img src="{{evidence_image_data_uri}}" alt="Screenshot evidence for {{title}}">{{/has_evidence_image}}{{^has_evidence_image}}Screenshot unavailable; use the selector and screen context.{{/has_evidence_image}}</div>
        <div><strong>Visual callout</strong><p><b>Target:</b> {{visual_target}}</p><p><b>Selector:</b> <code>{{visual_selector}}</code></p><p><b>Screen:</b> {{visual_screen}}</p><p><b>Expected:</b> {{evidence_expectation}}</p></div>
      </section>
    </article>{{/top_issues_with_visual_evidence}}
    {{^top_issues_with_visual_evidence}}<div class="card">No critical/high UX issues or high-confidence implementation gaps were recorded.</div>{{/top_issues_with_visual_evidence}}
  </div>

  <h2>Minor improvements</h2>
  <ul>
    {{#quick_wins}}<li><strong>{{title}}</strong> &mdash; {{display_recommendation}}</li>{{/quick_wins}}
    {{^quick_wins}}<li>No minor improvements recorded.</li>{{/quick_wins}}
  </ul>

  <h2>Missing features</h2>
  <div class="findings">
    {{#missing_features}}<article class="finding">
      {{#validate_first}}<div class="ribbon">Validate first</div>{{/validate_first}}
      <span class="badge b-{{severity}}">{{severity}}</span><h3>{{expected_feature}}</h3>
      <div class="meta">{{mode}} &middot; {{confidence}} confidence &middot; {{competitor_ref}}</div>
      <p class="human-summary"><strong>Recommendation:</strong> {{display_recommendation}}</p>
      {{#has_technical_recommendation}}<details><summary>Technical recommendation</summary><p>{{technical_recommendation}}</p></details>{{/has_technical_recommendation}}
      <section class="visual">
        <div>{{#has_evidence_image}}<img src="{{evidence_image_data_uri}}" alt="Screenshot evidence for {{expected_feature}}">{{/has_evidence_image}}{{^has_evidence_image}}Screenshot unavailable; use the selector and screen context.{{/has_evidence_image}}</div>
        <div><strong>Visual callout</strong><p><b>Target:</b> {{visual_target}}</p><p><b>Selector:</b> <code>{{visual_selector}}</code></p><p><b>Screen:</b> {{visual_screen}}</p><p><b>Expected:</b> {{evidence_expectation}}</p></div>
      </section>
    </article>{{/missing_features}}
    {{^missing_features}}<div class="card">No missing features detected.</div>{{/missing_features}}
  </div>

  <h2>Old / inconsistent UI pages</h2>
  <div class="findings">
    {{#old_ui}}<article class="finding"><h3>{{title}}</h3><p class="human-summary">{{human_summary}}</p>
      <ul>{{#evidence_items}}<li><strong>{{screen_title}}</strong>{{#screen_url}} &mdash; <code>{{screen_url}}</code>{{/screen_url}}</li>{{/evidence_items}}
      {{^evidence_items}}<li>No screen details were captured.</li>{{/evidence_items}}</ul>
    </article>{{/old_ui}}
    {{^old_ui}}<div class="card">None detected.</div>{{/old_ui}}
  </div>

  <h2>Broken screens</h2>
  <ul>
    {{#broken_screens}}<li><code>{{screen_url}}</code></li>{{/broken_screens}}
    {{^broken_screens}}<li>None detected.</li>{{/broken_screens}}
  </ul>

  <h2>Per-session reports</h2>
  <table>
    <thead><tr><th>#</th><th>Session</th><th>Screens</th><th>UX score</th><th>Report</th></tr></thead>
    <tbody>
      {{#sessions}}
        <tr>
          <td>{{ordinal}}</td>
          <td>{{name}}</td>
          <td>{{screens}}</td>
          <td>{{ux_score}}</td>
          <td>{{#has_report}}<a href="{{report_url}}" target="_top">Open report #{{report_id}}</a>{{/has_report}}{{^has_report}}Not available{{/has_report}}</td>
        </tr>
      {{/sessions}}
    </tbody>
  </table>

  <details>
    <summary>Implementation prompts (developers)</summary>
    <p>Critical/high/medium UX findings and in-scope implementation gaps. Artifact: <code>{{cursor_prompts_path}}</code></p>
    {{#cursor_quick_wins}}<h3>{{title}}{{expected_feature}}</h3><pre>{{developer_prompt}}</pre>{{/cursor_quick_wins}}
    {{^cursor_quick_wins}}<p>No implementation prompts recorded.</p>{{/cursor_quick_wins}}
  </details>

  <div class="footer">Generated {{generated_at}} by smoke.aicountly.org &middot; observer mode.</div>
</main></body>
</html>
