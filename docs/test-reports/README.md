# Test Reports

Per-feature test reports: unit tests, build/synth gates, and real-AWS end-to-end validation
results. One report per feature (mapped to a GitHub issue / PR).

| Feature | Issue | PR | Report | Result |
|---|---|---|---|---|
| Cost Anomaly Detection as code | #1 | #11 | [feature-01](./feature-01-cost-anomaly-detection.md) | PASS |
| Bedrock token-quota / throttle monitoring | #2 | #12 | [feature-02](./feature-02-token-quota-monitoring.md) | PASS |
| Prompt-cache savings KPI | #3 | #10 | [feature-03](./feature-03-cache-savings-kpi.md) | PASS |
| Budget Action hard-stop + per-principal enforcement | #4, #5 | #15 | [feature-04-05](./feature-04-05-controls.md) | PASS |
| Request-metadata tagging helper | #6 | #13 | [feature-06](./feature-06-enforce-tagging.md) | PASS |
| Per-project pre-aggregation (DynamoDB) | #7 | #16 | [feature-07](./feature-07-project-preaggregation.md) | PASS |
| Fargate ETL implementation | #8 | #14 | [feature-08](./feature-08-fargate-etl.md) | PASS |
| CORS lockdown + custom domain + mapping-upload UX | #9 | #17 | [feature-09](./feature-09-cors-domain.md) | PASS |
| Web UI completion (By-Project toggle + Governance page) | — | #18 | [feature-10](./feature-10-web-ui-completion.md) | PASS |
| Quota panel accuracy | — | #24 | [feature-11](./feature-11-quota-panel-accuracy.md) | PASS |
| DORA metrics dashboard (human + AI-assisted delivery) | — | #37 | [feature-12](./feature-12-dora-metrics.md) | PASS |
| Project cost attribution × DORA join | — | #39 | [feature-13](./feature-13-project-cost-attribution.md) | PASS |
| AI-coding ROI page (cost × DORA × manpower) | — | #40 | [feature-14](./feature-14-roi-page.md) | PASS |
| Canonical DORA labels (say what is measured) | — | #42 | [feature-15](./feature-15-dora-canonical-labels.md) | PASS |
| DORA copy density (one card, one measurement) | — | #43 | [feature-16](./feature-16-dora-copy-density.md) | PASS |
| Athena attribution parity (Full view sees the profile tier) | — | #44 | [feature-17](./feature-17-athena-attribution-parity.md) | PASS |
| Live ROI model diagram (measured · assumed · refused, per project) | — | #45 | [feature-19](./feature-19-roi-model-diagram.md) | PASS |
| UX foundation (tokens, icons, tiles, help panel, dark theme) | — | #46 | [feature-20](./feature-20-ux-foundation.md) | PASS |
| Global time range (one control, URL-synced, every page states its period) | — | #48 | [feature-21](./feature-21-global-time-range.md) | PASS |
| Anomaly table key-shape drift (one key definition + one-off row repair) | — | #50 | [feature-22](./feature-22-anomaly-key-shape.md) | PASS |
| Model-hop latency (measured hops only, fleet scope stated) | — | #52 | [feature-18](./feature-18-latency-observability.md) | PASS |
| Model-hop latency — inference-profile ids resolved to model names (qa F-PR52-002) | — | #53 | [feature-18b](./feature-18b-latency-profile-labels.md) | PASS |
| Projects / ROI follow-ups (F-1706 cent drift, F-1707 refusal scope) | — | #49 | [feature-21b](./feature-21b-projects-roi-followups.md) | PASS |
| Overview landing page + `/v1/overview` (spend vs prior period, budget status, anomalies, delivery) | — | #51 | [feature-23](./feature-23-overview-page.md) | PASS |
| ROI + Cost tables (one table + one chart; merged model rows, totals, folded noise) | — | #54 | [feature-24](./feature-24-roi-cost-tables.md) | PASS |
| Settings page (admin registry + DORA repos out of the monitoring pages) | — | #55 | [feature-25](./feature-25-settings-and-format.md) | PASS |
| QA loop honesty (the check colour matches the report; the bot stays inside the plan) | — | #56 | [feature-26](./feature-26-qa-loop-honesty.md) | PASS |
| Cost page windowing (Cost follows the global time range; `/v1/overview.byModel.cacheSavingsUsd`; Budget-tile source note; one Anomalies control) | — | #57 | [feature-27](./feature-27-cost-windowing.md) | PASS |
| ROI model diagram layout (footnotes no longer under the result box; owner-reported) | — | #59 | [feature-19b](./feature-19b-roi-diagram-layout.md) | PASS (gates + local render) |

| Latency per project (invocation-log rollups; bucket estimates beside exact fleet figures; guarded backfill) | — | #61 | [feature-28](./feature-28-latency-per-project.md) | PASS |
| PROJDAY one-day repair (2026-09-17 over-count) + qa disclosure rule | — | #62 | [feature-30](./feature-30-projday-repair-qa-disclosure.md) | PASS |
| Chart \| Table twin on the four chart panels (Usage, DORA ×2, AI ROI) — table view with the same figures as the tooltip | — | #63 | [feature-29](./feature-29-chart-table-toggle.md) | PASS (gates + local render) |
| /latency fleet-vs-per-model series disclosure (qa F-PR63-001) | — | #64 | [feature-31](./feature-31-latency-series-disclosure.md) | PASS |
| qa empty-run honesty (UNKNOWN never becomes PASS; exploration evidence; per-PR concurrency) | — | #65 | [feature-32a](./feature-32a-qa-empty-run-honesty.md) | PASS |
| DORA tables open on their top rows (top 10 + "Show all N"; repositories by merged PRs, projects by spend) | — | #66 | [feature-33](./feature-33-dora-tables-topn.md) | PASS (gates + local render) |
| Every figure reconciles with the one beside it (/roi day-count, /latency ranked rows + remainder + account-vs-tenant, rate card 5.x rows, /dora label, /projects Full − Fast) | — | #67 | [feature-34](./feature-34-numbers-reconcile.md) | PASS (gates + live Lambda + served bundle; qa pending) |
| Cost page id consistency (one definition of model/id for rows, tile and footer; qa F-PR66-001/006, F-PR67-001) | — | #68 | [feature-35](./feature-35-cost-id-consistency.md) | PASS (gates + local render) |
| Prompt-cache writes priced (1.25×/2× input by logged TTL; all four rollups + guarded backfill; Nova Micro + untagged-profile pricing, qa F-PR68-002; `rollupsLastRunAt`) | — | #69 | [feature-36](./feature-36-cache-write-pricing.md) | PASS (gates + bill reconciliation + live) |
Each report records: scope, unit-test results, build/synth gates, real-AWS validation evidence,
any defect found+fixed during validation, and a verdict. Reports are written before opening the
PR; a feature is only PR-ready when all gates are green.

> Two items are 🟡 in [`../ROADMAP.md`](../ROADMAP.md) — the live Budget Action freeze (#4/#5) and
> the Fargate Parquet run (#8) — implemented and deploy-validated, with their live action
> deliberately deferred (risk-managed). These are planned roadmap items, not defects.
