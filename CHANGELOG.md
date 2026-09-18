# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is reference/sample software, so entries
are grouped by development milestone rather than strict semver releases.

## [Unreleased]

### Security — the QA agents' own output no longer reaches a PR comment unscrubbed
- **A workflow-authored comment is not covered by GitHub's secret masking.** Masking scrubs the
  runner's *log stream*; a body that `actions/github-script` builds in JavaScript and hands to
  `issues.createComment` goes straight to the REST API and never passes that filter. The UI QA agent
  narrates its own uploads (`published report to s3://token-monitor-qa-reports-<id>/pr-43/…`), the
  workflow embedded that narration verbatim in a "Full agent output" block, and this repository is
  public — so the account id was published on every QA run while the job log, where the same string
  appeared correctly as `token-monitor-qa-reports-***`, made it look contained. 40 comments across
  nine pull requests were affected; each has been deleted and reposted with the value masked.
- **New `.github/scripts/redact.js`, and both comment sinks now go through it.** One shared pattern
  list (account ids, access keys, secret keys, GitHub tokens, Anthropic keys, JWTs), AWS's published
  example accounts deliberately exempt. `ui-qa-agent.yml` scrubs the QA and bug-fix agents' output;
  `sdlc-gate.yml` scrubs the LLM-authored advisory review, which is the same class of untrusted text.
- **The control is the assertion, not the call.** Each step re-checks the *final* body with
  `findSecrets()` and, if anything survived, drops the agent-authored sections rather than posting
  them — falling back last to a header that interpolates nothing an agent wrote. A redactor that is
  merely invoked is one nobody notices has stopped working.

### Changed — UX foundation: one visual system, a help panel, a dark plane
- **Design tokens.** Type scale (11–28 px, four weights), spacing scale, semantic colours, chart
  chrome and eight validated series slots, all in `styles.css`; every rule reads from them. The
  content plane is now **dark by default**, unified with the sidebar; a light set is an explicit
  opt-in (`<html data-theme="light">`), not OS-driven.
- **Icons and navigation.** Hand-rolled inline SVG icons replace every emoji in the shell; the nav is
  grouped **Spend / Governance / Delivery**; wordmark brand; the stray browser-default `Sign out`
  outside the shell is gone. *Emoji were replaced for consistency — no source says they are
  unacceptable; the two claims that Cloudscape forbids them were refuted in research.*
- **KPI tiles.** `Kpi` now renders through `KpiTile` — label, one-line definition, value in
  proportional figures, optional delta against a named period, sparkline, status chip, link — and a
  card whose label has a help entry gains an ⓘ automatically. No page was edited for this.
- **Help panel.** A right rail (≥ 1100 px) or modal (below) answering *What is this · Why it matters ·
  How it's calculated · Caveats · Learn more* from one registry (`lib/help-content.ts`, 28 entries
  covering every KPI on every page, content lifted from the former card captions and caveat
  paragraphs). Keyboard-openable, Esc-closable, focus-restoring.
- **Charts.** `charts/theme.ts` carries the palette (colour follows the entity — Opus is always slot 1,
  human/AI cohorts are blue/orange — never the rank), hairline solid grid, flat 10 % area fills, thin
  marks; the Usage chart adopts it here. The old DORA human/AI pair (`#2563eb` vs `#6366f1`) failed
  the colour-vision check (normal-vision ΔE 6.6 against a floor of 15, protan 1.9) and is replaced.
- **Empty states** component with status text and an action slot; `StatCard.tsx` (dead code) removed;
  `/usage` alias and unknown-route redirect.
- Research and audit behind all of the above: `docs/research-dashboard-ux.md`.
### Added — the ROI model as a picture, with the selected project's numbers in it
- **`/roi` now draws its model** inside "How to read this page": three input columns (measured by
  this portal · configured assumptions · DORA's first-year model), the Value and Investment totals,
  `ROI = (Value − Investment) ÷ Investment`, payback and break-even. Inline SVG on the theme tokens,
  `role="img"` with title/description, text selectable. A project selector (shared with the forward
  estimator) fills every box with that project's own value, tagged *measured*, *assumed* or
  *derived*; components the page refused to compute are faded with the refusal reason.
- **"J-curve" is renamed "Adoption dip"** on the diagram, the waterfall series and the API
  methodology string (`roi.ts`), with DORA's term kept once in parentheses; the diagram footer
  defines it in one sentence — temporarily slower while learning the tool, one-time, first year
  only, off by default, editable per project. Two open caveats are stated on the diagram rather
  than fixed: the dip is a people-level cost charged once per project, and the model is
  first-year while this portal computes on rolling windows.
- No computed value changes. Reviewed live at the 2026-09-18 customer demo before landing here.
### Changed — DORA cards: one card, one measurement
- **Every card is now a canonical noun label, at most one qualifier chip, one number and one line
  of sample provenance.** The previous pass made the page factually correct by stacking its caveats
  onto the card faces: the deployment-frequency card carried three competing headlines for one
  fact, and one caption line merged four categories under a single separator. The caveats are
  relocated, not deleted.
- **No band, tier or benchmark on any card face — this reverses the entry below.** DORA's own live
  instrument scores software delivery performance on a continuous scale against an industry mean;
  `Elite`/`High`/`Medium`/`Low` appear zero times as labels in it, and the 2025 report speaks of
  clusters, not levels. So the measured rate leads and the 2024 bands become a dated reference table
  inside the disclosure. Dating them was right; leading with them was not. No percentile is shown
  either: it is the defensible substitute for a band, and it needs a benchmark distribution this
  product does not have — which the disclosure states rather than leaving the absence unexplained.
- **Labels are DORA's canonical nouns from one surface, cited by URL** — deployment frequency,
  change lead time, **change fail rate** (not "change failure rate"), failed deployment recovery
  time, deployment rework rate. DORA's own surfaces disagree with each other about these names, so
  attributing our wording to "DORA" generically would be unfalsifiable. The payload field and the
  interface were renamed to match.
- **Cards are grouped under DORA's own umbrella**, software delivery performance: throughput and
  stability, with recovery time under stability, where three of DORA's four first-party surfaces
  put it even though its definitions guide files it under throughput.
- **One "Definitions & limitations" disclosure** on native `<details>/<summary>` — keyboard- and
  touch-openable with no ARIA wiring — absorbs both long caveat paragraphs, the measurement notes,
  both table captions and every caveat-carrying tooltip. Information a reader needs cannot live in
  a hover tooltip. Coverage state stays on the card face: "not collected" and an empty sample are
  findings about a tenant's data, not definitions.
- **The AI metric left the DORA grid.** No DORA metric covers AI-authored share, so sitting it
  among the five implied a sanction that does not exist. It heads the cohort panel and is named for
  exactly what it counts: pull requests carrying an AI co-author trailer. The cohort split likewise
  became its own row instead of a fragment appended to every card caption.
- `dataSource` now ships `canonicalSource` and `bandReference` — the 2024 thresholds in the words a
  reader compares with, derived from the tier thresholds so the two cannot drift, and excluding
  change fail rate by construction. `DATA_SOURCE.notes` carries one claim per note.
- Evidence: `docs/research-dora-card-copy.md` (8 findings, each adversarially verified). Terseness
  itself is a design judgement, not a research finding — the comprehension angle was refuted.
- No computed metric value changed.

### Changed — the DORA page now says what it actually measures
- **Deployment frequency reads as DORA's ordinal band**, e.g. "between once per day and once per
  week", with the per-day rate demoted to supporting detail. Every DORA instrument states this
  metric as one of six phrases; the decimal rate was our intermediate arithmetic, and it is the
  form a non-expert reader misreads. The six bucket strings are used verbatim, and the one
  boundary the sources leave open — a rate of exactly 1.0/day — is resolved upward and documented.
  *Superseded by the entry above: DORA's live instrument uses no band as a label, so the measured
  rate leads and the band moved into the definitions disclosure.*
- **"Proxy" moved from a footnote into the label.** A merge to the default branch is not a
  production deployment, and DORA's own reference implementation warns that deriving deployment
  metrics from merge events skews them. The reader who only reads labels is exactly the reader who
  must not miss that.
- **No tier badge on change failure rate.** The published 2024 values are non-monotonic across the
  performance levels — Elite 5%, High 20%, Medium 10%, Low 40% — because the levels are clusters
  over all metrics at once, so no threshold on one metric can reproduce them. The four values are
  shown as reference marks instead, with the reason stated where the number is, and `tierFor` now
  refuses that metric structurally rather than by convention.
- **Tier badges are dated to the 2024 report** and carry DORA's own caveats: annual survey
  benchmarks applied per application or service, not grades or a maturity model. The 2025 report
  replaced the four levels with seven team archetypes, so an undated badge asserts a framework that
  has since moved. An empty sample now reads "no band" rather than an unqualified "Unknown".
  *Superseded by the entry above: the badges are off the page entirely, and the dated bands survive
  as a reference table inside the disclosure.*
- **The fifth metric is named.** DORA has had five metrics since 2024; deployment rework rate needs
  a signal marking a deployment as planned or corrective, which nothing in this pipeline records.
  The page says so on its own tile instead of presenting four metrics as the whole framework.
- **Recovery time keeps an honest name.** DORA renamed *and* redefined this metric in 2023, and the
  new scope covers only impairments caused by a change reaching production; ours also counts bug
  and incident issues with no deployment linkage. Adopting the new name over an unchanged
  computation would be worse than the old label, so the tile says what it measures instead.
- Evidence for all of the above: `docs/research-dora-presentation.md` (14 claims from DORA's
  primary sources, adversarially verified). No computed value changed except the removed tier.

### Fixed — the Full (Athena) project view now attributes profile-routed traffic
- **The Athena statements gained the application-inference-profile tier**, ahead of
  `requestMetadata.project_id`, in the same order the aggregator applies. Profile-routed calls log
  the profile ARN as `modelId` and carry no `project_id`, so the strongest attribution tier — the
  one this product recommends and can enforce — was the one the Full view could not see: on live
  data it reported 99.97 % `untagged` against 20 attributed projects in Fast, and a project
  attributed only by profile routing was absent from it entirely (qa F-1101). Both statements —
  the async `byProject` template the page runs and the synchronous `/v1/projects` — inline the
  registry's resolved-profile cache (a no-`ELSE` `CASE`, and a `VALUES` CTE) rather than mirroring
  it to a second store; an empty or unreadable cache degrades to the previous SQL with a warning.
- **The page's copy overstated intentionality.** It called the whole Fast/Full divergence "by
  design"; only part of it was. It now names the two tiers Full cannot resolve — the admin identity
  hint and the one-time historical back-fill, which exist only as rollup state — and says the
  residual `untagged` share is those two tiers, not lost usage. On dev the residue reconciles to
  the token: 98.8 % pre-profile history, 1.2 % identity-hint territory.
- **One project, one name.** A row attributed by profile is labelled by project id; both Full paths
  now relabel from the project registry, so a project reads identically in Fast and Full.
- **Currency has thousands separators** (`$13,858.35`), locale pinned to `en-US` (qa F-1102).
- **The bug-fix agent reports "nothing patchable" as a result, not a failure.** Its non-zero exit
  under `bash -e` aborted the qa step before the workflow's own comment, stall-detector and fuse
  steps, so an unfixable finding produced a red check with no explanation. It also now salvages a
  diff from a max-token-truncated reply (the closing fence never arrives) and asks for the diff
  before the analysis. Hardening it does not green PR #43 by itself — the finding needed this fix.

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
