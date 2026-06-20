<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{run_code}} - Final Consolidated Report</title>
  <style>
    body { font: 14px/1.5 Inter, system-ui, sans-serif; color: #0f172a; background: #fff; margin: 32px; }
    h1 { color: #10B981; margin: 0 0 4px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0 32px; }
    .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; background: #fff; }
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
    .footer { color: #94a3b8; font-size: 11px; margin-top: 48px; }
  </style>
</head>
<body>
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
    <div class="card"><div class="l">Critical</div><div class="v">{{severity_summary.critical}}</div></div>
    <div class="card"><div class="l">High</div><div class="v">{{severity_summary.high}}</div></div>
    <div class="card"><div class="l">Medium</div><div class="v">{{severity_summary.medium}}</div></div>
    <div class="card"><div class="l">Low</div><div class="v">{{severity_summary.low}}</div></div>
  </div>

  <h2>Quick wins</h2>
  <ul>
    {{#quick_wins}}<li><strong>{{title}}</strong> &mdash; <span class="badge b-{{severity}}">{{severity}}</span> &mdash; {{recommendation}}</li>{{/quick_wins}}
    {{^quick_wins}}<li>No quick wins recorded.</li>{{/quick_wins}}
  </ul>

  <h2>Missing features</h2>
  <table>
    <thead><tr><th>Feature</th><th>vs Competitor</th><th>Severity</th><th>Recommendation</th></tr></thead>
    <tbody>
      {{#missing_features}}
        <tr>
          <td>{{expected_feature}}</td>
          <td>{{competitor_ref}}</td>
          <td><span class="badge b-{{severity}}">{{severity}}</span></td>
          <td>{{recommendation}}</td>
        </tr>
      {{/missing_features}}
      {{^missing_features}}<tr><td colspan="4">No missing features detected.</td></tr>{{/missing_features}}
    </tbody>
  </table>

  <h2>Old / inconsistent UI pages</h2>
  <ul>
    {{#old_ui}}<li>{{title}} &mdash; {{evidence_json}}</li>{{/old_ui}}
    {{^old_ui}}<li>None detected.</li>{{/old_ui}}
  </ul>

  <h2>Broken screens</h2>
  <ul>
    {{#broken_screens}}<li><code>{{screen_url}}</code></li>{{/broken_screens}}
    {{^broken_screens}}<li>None detected.</li>{{/broken_screens}}
  </ul>

  <h2>Per-session reports</h2>
  <table>
    <thead><tr><th>#</th><th>Session</th><th>Screens</th><th>UX score</th><th>HTML</th></tr></thead>
    <tbody>
      {{#sessions}}
        <tr>
          <td>{{ordinal}}</td>
          <td>{{name}}</td>
          <td>{{screens}}</td>
          <td>{{ux_score}}</td>
          <td><a href="{{html_path}}">open</a></td>
        </tr>
      {{/sessions}}
    </tbody>
  </table>

  <div class="footer">Generated {{generated_at}} by smoke.aicountly.org &middot; observer mode.</div>
</body>
</html>
