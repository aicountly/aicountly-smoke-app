<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{run_code}} / {{session_name}}</title>
  <style>
    body { font: 14px/1.55 Inter, system-ui, sans-serif; color: #0f172a; background: #f8fafc; margin: 0; padding: 32px; }
    main { max-width: 1100px; margin: auto; }
    h1 { color: #10B981; margin-bottom: 4px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0 32px; }
    .card, .finding { border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px; background: #ffffff; position: relative; }
    .card .l { font-size: 12px; color: #64748b; }
    .card .v { font-size: 26px; font-weight: 600; margin-top: 4px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .findings { display: grid; gap: 16px; }
    .finding h3 { margin: 5px 0; }
    .human-summary { white-space: pre-wrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    .b-critical { background: #fee2e2; color: #7f1d1d; }
    .b-high     { background: #fef3c7; color: #78350f; }
    .b-medium   { background: #e0f2fe; color: #0c4a6e; }
    .b-low      { background: #ecfdf5; color: #065f46; }
    .b-suggestion { background: #f1f5f9; color: #334155; }
    .b-memory { background: #ede9fe; color: #5b21b6; }
    .b-user { background: #dbeafe; color: #1e3a8a; }
    .b-timeout { background: #fee2e2; color: #7f1d1d; }
    .b-cancelled { background: #f1f5f9; color: #334155; }
    .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .shot { margin: 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
    .shot img { display: block; width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; }
    .shot figcaption { margin-top: 8px; overflow-wrap: anywhere; }
    .visual { display: grid; grid-template-columns: minmax(180px, 320px) 1fr; gap: 14px; align-items: start; margin-top: 14px; padding: 12px; border-left: 4px solid #10b981; background: #f0fdf4; border-radius: 8px; }
    .visual img { width: 100%; border: 1px solid #cbd5e1; border-radius: 7px; }
    .visual p { margin: 3px 0; overflow-wrap: anywhere; }
    .recommendation { font-size: 15px; }
    .ribbon { position: absolute; right: 0; top: 0; padding: 5px 12px; border-radius: 0 12px 0 10px; background: #fef3c7; color: #92400e; font-weight: 700; }
    details { margin-top: 14px; }
    summary { cursor: pointer; font-weight: 650; }
    .footer { color: #94a3b8; font-size: 11px; margin-top: 48px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 14px; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #e5e7eb; padding: 7px; text-align: left; }
    @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, 1fr); } .visual { grid-template-columns: 1fr; } }
  </style>
</head>
<body><main>
  <h1>{{run_code}} &middot; {{session_name}}</h1>
  <div class="meta">
    <strong>Product:</strong> {{product_name}} &nbsp;
    <strong>Environment:</strong> {{environment}} &nbsp;
    <strong>Status:</strong> {{status}} &nbsp;
    <strong>Started:</strong> {{started_at}} &nbsp;
    <strong>Completed:</strong> {{completed_at}}<br>
    <strong>Menu path:</strong> <code>{{menu_path}}</code><br>
    <strong>Maturity Score:</strong> {{maturity_label}} &nbsp;
    <strong>UX Score:</strong> {{ux_score}}/100
  </div>

  <div class="grid">
    <div class="card"><div class="l">Screens observed</div><div class="v">{{screens_observed}}</div></div>
    <div class="card"><div class="l">UI items catalogued</div><div class="v">{{inventory_count}}</div></div>
    <div class="card"><div class="l">Critical UX</div><div class="v">{{severity_summary.critical}}</div></div>
    <div class="card"><div class="l">High UX</div><div class="v">{{severity_summary.high}}</div></div>
  </div>

  <h2>Decisions taken</h2>
  <p class="meta">Choices made while the worker was blocked, including remembered answers applied automatically.</p>
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
    {{^decisions}}<div class="card">No mid-run decisions were required for this session.</div>{{/decisions}}
  </div>

  <h2>What to fix now</h2>
  <p class="meta">Start with each plain-language recommendation. Technical implementation material is collected in the collapsed appendix.</p>

  <h2>UX issues</h2>
  <div class="findings">
    {{#ux_issues}}<article class="finding">
      <span class="badge b-{{severity}}">{{severity}}</span>
      <h3>{{title}}</h3><div class="meta">{{category}}</div>
      <p class="recommendation human-summary"><strong>Recommendation:</strong> {{display_recommendation}}</p>
      {{#has_technical_recommendation}}<details><summary>Technical recommendation</summary><p>{{technical_recommendation}}</p></details>{{/has_technical_recommendation}}
      <section class="visual">
        <div>{{#has_evidence_image}}<img src="{{evidence_image_data_uri}}" alt="Screenshot evidence for {{title}}">{{/has_evidence_image}}{{^has_evidence_image}}Screenshot unavailable; use the selector and screen context.{{/has_evidence_image}}</div>
        <div><strong>Visual mockup</strong><p><b>Target:</b> {{visual_target}}</p><p><b>Selector:</b> <code>{{visual_selector}}</code></p><p><b>Screen:</b> {{visual_screen}}</p><p><b>Expected:</b> {{evidence_expectation}}</p></div>
      </section>
    </article>{{/ux_issues}}
    {{^ux_issues}}<div class="card">No UX issues recorded.</div>{{/ux_issues}}
  </div>

  <h2>Feature gaps vs competitors</h2>
  <div class="findings">
    {{#feature_gaps}}<article class="finding">
      {{#validate_first}}<div class="ribbon">Validate first</div>{{/validate_first}}
      <span class="badge b-{{severity}}">{{severity}}</span>
      <h3>{{expected_feature}}</h3><div class="meta">{{mode}} &middot; {{confidence}} confidence</div>
      <p class="recommendation human-summary"><strong>Recommendation:</strong> {{display_recommendation}}</p>
      {{#has_technical_recommendation}}<details><summary>Technical recommendation</summary><p>{{technical_recommendation}}</p></details>{{/has_technical_recommendation}}
      <section class="visual">
        <div>{{#has_evidence_image}}<img src="{{evidence_image_data_uri}}" alt="Screenshot evidence for {{expected_feature}}">{{/has_evidence_image}}{{^has_evidence_image}}Screenshot unavailable; use the selector and screen context.{{/has_evidence_image}}</div>
        <div><strong>Visual mockup</strong><p><b>Target:</b> {{visual_target}}</p><p><b>Selector:</b> <code>{{visual_selector}}</code></p><p><b>Screen:</b> {{visual_screen}}</p><p><b>Expected:</b> {{evidence_expectation}}</p></div>
      </section>
    </article>{{/feature_gaps}}
    {{^feature_gaps}}<div class="card">No feature gaps recorded.</div>{{/feature_gaps}}
  </div>

  <h2>File I/O tests</h2>
  <table>
    <thead><tr><th>Scenario</th><th>Direction</th><th>Result</th><th>Source hash</th><th>Result hash</th><th>AI quality</th></tr></thead>
    <tbody>{{#file_io_tests}}<tr><td>{{scenario_key}}</td><td>{{direction}}</td><td>{{status_label}}</td><td><code>{{source_sha256}}</code></td><td><code>{{result_sha256}}</code></td><td>{{ai_overall}}</td></tr>{{/file_io_tests}}
    {{^file_io_tests}}<tr><td colspan="6">No File I/O tests ran.</td></tr>{{/file_io_tests}}</tbody>
  </table>
  <h2>Export quality vs competitors</h2>
  <div class="findings">{{#file_io_tests}}<article class="finding"><h3>{{scenario_key}}</h3><p>{{ai_verdict}}</p></article>{{/file_io_tests}}</div>

  <details>
    <summary>Technical details (for developers)</summary>
    <h3>UX issue implementation prompts</h3>
    {{#ux_issues}}<h4>{{title}}</h4><pre>{{developer_prompt}}</pre>{{/ux_issues}}
    {{^ux_issues}}<p>No UX issue prompts recorded.</p>{{/ux_issues}}
    <h3>Feature gap implementation prompts</h3>
    {{#feature_gaps}}<h4>{{expected_feature}}</h4><pre>{{developer_prompt}}</pre>{{/feature_gaps}}
    {{^feature_gaps}}<p>No feature gap prompts recorded.</p>{{/feature_gaps}}
    <h3>Complete Cursor prompt pack</h3>
    <p>Artifact: <code>{{cursor_prompts_path}}</code></p>
    <pre>{{cursor_prompts}}</pre>
  </details>

  <h2>Observed screens</h2>
  <div class="shots">
    {{#screenshot_cards}}<figure class="shot">
      {{#image_data_uri}}<img src="{{image_data_uri}}" alt="{{screen_title}}">{{/image_data_uri}}
      {{^image_data_uri}}<div class="meta">Screenshot file unavailable.</div>{{/image_data_uri}}
      <figcaption><strong>{{screen_title}}</strong><br><code>{{screen_url}}</code><br><span class="meta">Captured {{captured_at}}</span></figcaption>
    </figure>{{/screenshot_cards}}
    {{^screenshot_cards}}<p style="color:#64748b">No observed screens recorded.</p>{{/screenshot_cards}}
  </div>

  <div class="footer">Generated {{generated_at}} by smoke.aicountly.org &middot; observer mode.</div>
</main></body>
</html>
