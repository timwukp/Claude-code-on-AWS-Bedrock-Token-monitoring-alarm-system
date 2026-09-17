# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is reference/sample software, so entries
are grouped by development milestone rather than strict semver releases.

## [Unreleased]

### Added — AI-coding ROI page
- **`/roi` sub-page** answering "is the AI coding spend worth it?" from measured data instead of
  vendor claims: per-project ROI over this portal's own per-project spend rollups and per-repo
  DORA metrics, plus labor-cost assumptions the customer owns and can edit. `GET /v1/roi/projects`
  and `GET /v1/roi/estimate` on a new read-only Lambda.
- **Break-even leads the page** — monthly spend ÷ loaded hourly cost = the engineer-hours the
  assistant must save to pay for itself, expressed as a share of team capacity. Two inputs and no
  revenue guesses, so a reviewer who rejects every other assumption still gets a usable number.
- **Model provenance**: the published DORA first-year AI ROI model, formulas verified against that
  calculator's own source. Net time saved floors at **−100%** (the verification tax can exceed the
  saving), the stability term is **signed** so a regression is reported as a cost, and training
  and the J-curve dip are one-time and never annualized. Windows are 30/90 days only —
  annualizing a week is refused with an explanation. Full write-up: `docs/ROI_METHODOLOGY.md`.
- **Honest uncertainty**: the experimental bracket for AI coding speed (**−19%…+56%**, three RCTs
  with opposite signs) is displayed as a range rather than collapsed into a multiplier. Surveys
  are rejected as an input — in one trial developers forecast +24%, measured −19%, and still
  believed +20% afterwards. Three widely quoted productivity headlines were refuted during
  adversarial verification and appear nowhere in the product.
- **Refusals are a feature**: terms without inputs (no revenue base, no stability baseline, under
  4 weeks of history) are refused on-page with a stated reason, never zero-filled. Three of those
  refusals guard the composite percentage itself, each one found by reading real per-project data
  rather than tests: a window that **shipped nothing** (its value side would be assumption-only),
  a project with **no staffing of its own** (a shared team size claims one team's annual saving
  once per project, so a portfolio total becomes a multiple of a placeholder), and **spend below
  one engineer-hour per month** (a near-zero denominator turns a few dollars into a four-digit
  percentage). In all three the components, the measured spend and break-even are still shown, so
  the spend stays accountable — only the headline is withheld.
- **Forward budgeting**: reference-class P25/P50/P90 bands from a comparable project's own
  history × expected PRs per month, presented as a band and refused below 4 weeks of history.
- **Kill-fast, not gates**: a portfolio scatter plus a signal raised after two consecutive weeks
  of high spend and low merged output, judged against the *prior* weeks only (out-of-sample).
  Both are prompts for a human conversation, deliberately not automated controls.
- **Runaway-spend guard**: any single request above a configured dollar threshold (default $50,
  `0` disables) is written to the existing Anomalies feed with its model, project and cost, so a
  single agent loop burning thousands of dollars becomes visible within a rollup cycle.
- Registry projects gain optional, server-validated ROI assumptions, with org-wide defaults at
  `GET|PUT /v1/projects/registry/defaults` (writes admin-only) and the effective source
  (project / org / code) disclosed next to every number.

### Added — Project cost attribution × DORA join
- **Per-project application inference profiles** — new `Tums-<env>-Projects` stack creates one
  tagged AIP per project × model (tag `tums-project=<id>` → Cost Explorer/CUR after activation;
  a dedicated key, because the app-wide billing tag `project` overrides same-key resource tags).
  Calls made through a profile are attributed with zero client effort: the invocation log's
  `modelId` is the profile ARN, which the aggregator resolves (GetInferenceProfile + tags) and
  caches. Opt-in `enforcementPolicy` adds the two-statement "profiles-only" managed policy + a
  pilot test role.
- **Attribution precedence** in the log pipeline: AIP tag → `requestMetadata.project_id` →
  admin identity hint → `untagged`; profile-routed traffic is re-keyed to the real underlying
  model so per-model pricing and the Cost page stay accurate.
- **Daily project rollups** (`TENANT#<t>#PROJDAY`) so project cost answers the same 7/30/90-day
  windows as DORA; one-off `scripts/backfill-projday.ts` retro-fills history without touching
  existing rollups.
- **One-time historical attribution (owner-directed)** — pre-AIP usage carried no signal
  (99.7% untagged), so it was attributed once by correlating hourly usage with per-repo commit
  timestamps (±2h; 90% of tokens matched). The backfill's `HOUR_PROJECT_MAP` mode injects the
  mapped project only where no real signal exists (precedence unchanged), migrates the all-time
  rollups out of `untagged` with equal-and-opposite atomic ADDs, and a `SYSTEM#RETRO` marker
  makes the migration unrepeatable. Raw logs stay immutable — the Athena Full view keeps
  reporting call-time truth.
- **Project registry** (`tums-tenants`, previously unused): project → name / cost center /
  repos / identity hints; `GET|POST /v1/projects/registry`, `DELETE /v1/projects/registry/{id}`
  (admin), seeded once from config. By-Project page shows registry names and gains an admin
  management panel; per-model pricing replaces the flat-rate scaling on the fast path.
- **IAM matrix validated live** — pilot role: invoke via tagged AIP = Allow; direct model ids
  = AccessDenied; confirms `bedrock:InferenceProfileArn` matches the AIP ARN when it wraps a
  cross-region profile (closes the research open question).
- **Delivery × Cost panel** on the DORA page — `GET /v1/dora/projects?window=`: per project,
  DORA metrics pooled across its repos + tokens + est. USD + $/deployment ($/merged PR).
- **Pilot template** `.claude/settings.json.example`: route a repo's Claude Code sessions
  through its project profile ("clone repo = attributed"); real file stays untracked in this
  public repo (ARNs embed the account id) — private enterprise repos commit it directly.

### Added — DORA metrics dashboard
- **DORA page** (`/dora`) — per-repo Deployment Frequency, Lead Time for Changes, Change Failure
  Rate and Time to Restore, each split into **All / AI-assisted / Human-only** PRs plus an
  "AI participation" KPI, so teams can see whether working with AI coding assistants (Claude Code,
  Kiro, Amazon Q, Copilot) changes their delivery performance. Weekly deploy + lead-time charts,
  recent-PR table with assistant/revert/hotfix badges, cross-repo overview table, 7/30/90-day window.
- **Admin-managed repo list** — new Cognito `admin` group; members can add / remove / "sync now"
  target repos from the page. `GET|POST /v1/dora/repos`, `DELETE /v1/dora/repos/{owner}/{name}`,
  `POST …/sync`, `GET /v1/dora/metrics`, `GET /v1/dora/overview` (six routes, one Lambda).
- **Collector** — new `Tums-<env>-Dora` stack: scheduled Lambda (every 6 h, configurable) pulls
  merged PRs (+ commits for first-commit time and `Co-Authored-By` trailers) and bug/incident issues
  from GitHub into the new `tums-dora` table; incremental via per-repo watermarks, 180-day backfill,
  rate-limit aware. GitHub PAT lives in Secrets Manager (`token-monitor-demo/github-token`, created
  with a placeholder). Seed repos come from the `dora` config block on first run only.
- **Definitions** ported from `timwukp/dora-metrics-platform`: deployment = PR merged to the default
  branch (none of the tracked repos use the Deployments API); tiers follow the DORA bands.

### Added — Web UI completion
- **By-Project fast/full toggle** — the By-Project page now defaults to the DynamoDB pre-aggregated
  rollups (`?source=fast`) and offers a Full (Athena + project names) view; shows the data source.
- **Governance page** — new dashboard page + `GET /v1/governance` showing the Bedrock budget
  (limit / actual / forecast) and enforcement posture (Budget Action armed?, auto-containment
  mode). Read-only.

## Cost-governance feature set (issues #1–#9)

### Added
- **Cost Anomaly Detection as code (#1)** — `AWS::CE::AnomalyMonitor` (DIMENSIONAL/SERVICE) +
  `AWS::CE::AnomalySubscription` (IMMEDIATE→SNS, `ThresholdExpression`), replacing the manual script.
- **Bedrock token-quota / throttle monitoring (#2)** — `GET /v1/quotas` reports throttle status
  and per-model TPM / per-day quota headroom (Service Quotas); Usage page quota panel.
- **Prompt-cache savings KPI (#3)** — `/v1/costs` returns `cacheSavingsUsd`; Cost page shows how
  much prompt caching saves vs full input pricing (validated ~89% lower on real traffic).
- **Budget Action hard-stop + per-principal enforcement (#4, #5)** — opt-in, off-by-default
  `CfnBudgetsAction` (APPLY_IAM_POLICY) and a guarded containment path in the anomaly-response
  Lambda (refuses to act when disabled / allow-listed / unparseable — no self-lockout).
- **Request-metadata tagging helper (#6)** — `buildRequestMetadata` / `withRequestMetadata`
  (PII screening, Bedrock key/length limits) + `docs/INTEGRATION.md`.
- **Per-project pre-aggregation (#7)** — aggregator writes `TENANT#x#PROJECT` rollups;
  `GET /v1/projects?source=fast` reads DynamoDB instead of running Athena per request.
- **Fargate ETL job (#8)** — `etl.py` compacts raw NDJSON logs into partitioned Parquet (pure,
  offline-testable parser + stdlib unit tests).
- **CORS lockdown + custom domain + mapping-upload UX (#9)** — `api.allowedOrigins` config locks
  CORS to configured origins (default `*` for demo); optional ACM custom domain on CloudFront;
  `scripts/upload-project-mapping.sh`.

### Changed
- Fixed CI: the `infra` job installs backend deps so Lambda bundling (esbuild) works in a clean runner.
- Fixed a tenant-sanitizer bug that stripped `/` from IAM ARNs (forensic queries returned 0 rows).

### Testing
- Unit tests grew from 11 → 60+, plus per-feature English test reports under `docs/test-reports/`.
- Every feature validated end-to-end against a real AWS account (see `docs/VERIFICATION.md`).

## Initial release

### Added
- AWS-native, multi-tenant platform for monitoring Amazon Bedrock token usage: data pipeline
  (Model Invocation Logging → S3 → Glue/Athena), ingestion aggregator → DynamoDB, REST API behind
  Cognito, React/Vite dashboard (S3 + CloudFront), event-driven anomaly response.
- AWS CDK (TypeScript) infrastructure: Network / Data / Logging / Auth / Api / Automation / Etl /
  Frontend stacks.
- Documentation: architecture, Well-Architected review, monitoring approach, attribution,
  governance FAQ, roadmap, verification.
- CI: GitHub Actions + GitLab CI.
