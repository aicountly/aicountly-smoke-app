## Report back

Before opening any pull request, produce a verdict table covering every
finding above, in the order they appeared:

| # | Finding | Group | Verdict | File evidence | Action taken |
|---|---------|-------|---------|----------------|---------------|
| 1 | ... | A/B/C | CONFIRMED / ALREADY IMPLEMENTED / MIS-SCOPED / NEEDS PRODUCT DECISION | `path/to/file.tsx:L120` or similar | Fixed / No change needed / Reported to <repo> / Left for product owner |

Rules for the table and any resulting changes:

- Every row needs file evidence — a path and line reference, or the exact
  code/DOM you inspected — not just a restatement of the finding's own
  "Evidence" section.
- `MIS-SCOPED` rows must name the repository that actually owns the surface
  and must not be accompanied by a code change in this repository.
- `NEEDS PRODUCT DECISION` rows must not be accompanied by a code change;
  record the open question instead.
- Only `CONFIRMED` rows may have an associated diff.
- If a run spans more than one owner repository, open one pull request per
  repository, and do not mix findings from different repositories into the
  same PR.
- If you are unsure whether a finding is `CONFIRMED`, default to reporting
  it rather than implementing it. A missed fix costs less than a wrong one.

Return the verdict table as your final response, followed by a link to each
pull request you opened (if any).
