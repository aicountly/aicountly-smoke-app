<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{run_code}} / {{session_name}}</title>
  <style>
    body { font: 14px/1.5 Inter, system-ui, sans-serif; color: #0f172a; background: #fff; margin: 32px; }
    h1 { color: #10B981; margin-bottom: 4px; }
    .meta { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0 32px; }
    .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; background: #ffffff; }
    .card .l { font-size: 12px; color: #64748b; }
    .card .v { font-size: 26px; font-weight: 600; margin-top: 4px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 13px; }
    th { background: #f8fafc; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    .b-critical { background: #fee2e2; color: #7f1d1d; }
    .b-high     { background: #fef3c7; color: #78350f; }
    .b-medium   { background: #e0f2fe; color: #0c4a6e; }
    .b-low      { background: #ecfdf5; color: #065f46; }
    .b-suggestion { background: #f1f5f9; color: #334155; }
    .shots { display: flex; flex-wrap: wrap; gap: 8px; }
    .shots img { max-width: 280px; border: 1px solid #e5e7eb; border-radius: 8px; }
    .footer { color: #94a3b8; font-size: 11px; margin-top: 48px; }
  </style>
</head>
<body>
  <h1>{{run_code}} &middot; {{session_name}}</h1>
  <div class="meta">
    <strong>Product:</strong> {{product_name}} &nbsp;
    <strong>Environment:</strong> {{environment}} &nbsp;
    <strong>Status:</strong> {{status}} &nbsp;
    <strong>Started:</strong> {{started_at}} &nbsp;
    <strong>Completed:</strong> {{completed_at}}<br>
    <strong>Menu path:</strong> <code>{{menu_path}}</code>
  </div>

  <div class="grid">
    <div class="card"><div class="l">Screens observed</div><div class="v">{{screens_observed}}</div></div>
    <div class="card"><div class="l">UI items catalogued</div><div class="v">{{inventory_count}}</div></div>
    <div class="card"><div class="l">Critical UX</div><div class="v">{{severity_summary.critical}}</div></div>
    <div class="card"><div class="l">High UX</div><div class="v">{{severity_summary.high}}</div></div>
  </div>

  <h2>UX issues</h2>
  <table>
    <thead><tr><th>Severity</th><th>Category</th><th>Title</th><th>Recommendation</th><th>Developer prompt</th></tr></thead>
    <tbody>
      {{#ux_issues}}
        <tr>
          <td><span class="badge b-{{severity}}">{{severity}}</span></td>
          <td>{{category}}</td>
          <td>{{title}}</td>
          <td>{{recommendation}}</td>
          <td><code>{{developer_prompt}}</code></td>
        </tr>
      {{/ux_issues}}
      {{^ux_issues}}<tr><td colspan="5">No UX issues recorded.</td></tr>{{/ux_issues}}
    </tbody>
  </table>

  <h2>Feature gaps vs competitors</h2>
  <table>
    <thead><tr><th>Expected feature</th><th>Observed</th><th>Severity</th><th>vs Competitor</th><th>Recommendation</th></tr></thead>
    <tbody>
      {{#feature_gaps}}
        <tr>
          <td>{{expected_feature}}</td>
          <td>{{observed}}</td>
          <td><span class="badge b-{{severity}}">{{severity}}</span></td>
          <td>{{competitor_ref}}</td>
          <td>{{recommendation}}</td>
        </tr>
      {{/feature_gaps}}
      {{^feature_gaps}}<tr><td colspan="5">No feature gaps recorded.</td></tr>{{/feature_gaps}}
    </tbody>
  </table>

  <h2>Screenshots</h2>
  <div class="shots">
    {{#screenshots}}<img src="{{value}}" alt="">{{/screenshots}}
  </div>

  <div class="footer">Generated {{generated_at}} by smoke.aicountly.org &middot; observer mode.</div>
</body>
</html>
