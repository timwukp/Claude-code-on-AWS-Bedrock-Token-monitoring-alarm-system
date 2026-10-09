# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is reference/sample software, so entries
are grouped by development milestone rather than strict semver releases.

## [Unreleased]

### Fixed — the dashboard says what caching costs, and can no longer stop saying it (feature-37)
- **Copy and docs no longer call prompt caching a discount.** Cache reads are billed at 0.1× input, cache writes at
  1.25× (2× for a 1-hour cache); every sentence that said "billing discounts them", "the cheapest tokens you can buy"
  or "~89 % lower than full input pricing" now names both halves. The Cost tile **"Saved by prompt caching"** becomes
  **"Net effect of prompt caching"** — read savings minus the write premium, negative when caching cost more than it
  saved — with the two dollar lines it subtracts shown beside it; the column follows. The Overview Spend token figure
  now counts all four priced kinds, matching Usage; both freshness lines say "latest logged call … · rollups last ran …"
  (qa F-PR68-001 read the old "Data as of … refresh every 15 min" as a stalled aggregator on a quiet night).
- **Root cause on record:** `docs/incidents/2026-10-cache-write-omission.md` — a savings-framed feature priced the read
  and not the write; three rollup writers copied a four-counter list; nine consumers shared one card, so every
  cross-page reconciliation passed while every page was ~70 % low; the one external anchor read $0 in this account.
- **Guards:** `pricing-completeness.test.ts` (every token kind the parser extracts must be priced or allow-listed with a
  reason; red on the pre-fix tree for exactly the omission, green after), `rollup-fields.test.ts` (every writer and
  maintenance script carries every counter; all rollup shapes carry the same set), `scripts/check-rate-card.ts` (card vs
  AWS Price List; its first run after the fix caught a live change — Sonnet 5.5 cache read moved to $0.10/M on
  2026-10-07/08), and `docs/RECONCILIATION.md` (monthly comparison with the bill from the payer account, the only place
  it exists). The estimate is labelled a lower bound (~9 %) until the standard-route correction lands. (PR TBD)


### Fixed — prompt-cache writes are priced (feature-36)
- **The bill's largest token line was shown as $0.** Cost Explorer for this account (2026-06-01 → 10-05): input $4,285 ·
  output $5,163 · cache read $11,666 · **cache write $12,398 (37.0%)** — and the rate card priced no cache writes. The
  card now carries `cacheWrite5mPerToken` (1.25× input) and `cacheWrite1hPerToken` (2× input) per row, from the AWS
  Price List; the estimate reconciles with Cost Explorer's cache-write lines to −0.00% in total and within 0.04% per
  model inside the logging window (2026-06-04 → 10-05). **Cost is computed from stored tokens at read time, so every
  page reprices history:** the largest tenant's all-time total moves from $14,408 to $25,540 (+77%).
- **The TTL is read per call.** The aggregator lifts `usage.cache_creation.{ephemeral_5m,1h}_input_tokens` from the
  logged response body (and discards the body, as it does for latency) and stores `cacheWrite5mTokens` /
  `cacheWrite1hTokens` beside `cacheWriteTokens` on all four rollups. Writes whose TTL is not logged — history before
  the backfill, body-less records, the Athena/Full view — are priced at the 5-minute rate with the 1-hour price as
  `estimatedUsdUpperBound`. New fields: `cacheReadUsd`, `cacheWriteUsd`, `cacheWriteUnknownTtlTokens`, `cacheNetUsd`
  (cache-read savings minus the write premium), and the matching totals. The Cost page shows the two cache lines in
  dollars beside their token counts, so a row reads like the bill's four lines.
- **MODEL / PROJECT / PROJDAY never stored cache-write tokens**; `scripts/backfill-cache-write.ts` adds history onto
  them (dry run by default, one conditional marker per log object, stuck claims reported not re-added), and the
  repair script's `COUNTERS` include the three.
- **Runaway guard** prices cache writes, so a cache-heavy single request can trip it.
- **Three inference profiles priced at $0** (qa F-PR68-002): they resolved to Amazon Nova Micro but carried no project
  tag, and model resolution was coupled to tagging. An untagged profile now still rewrites the model id, the project
  falls through to the lower tiers, and Nova Micro is on the card ($0.035 / $0.14 / $0.00875 / $0 per MTok). Rows
  written under a profile ARN before this fix resolve to their model at read time on every cost endpoint (qa F-PR69-004).
- **`/v1/overview.rollupsLastRunAt`** (from `SYSTEM#WATERMARK.lastRunAt`, written on every aggregator run) separates
  "the aggregator ran" from "the newest log folded in" (`rollupsAsOf`), which qa F-PR68-001 conflated.
- **Still a lower bound:** the standard-route premium (×1.1 on `us.`/geo/inference-profile calls, ≈9% here) is a
  separate chain; the Cost page states it. Research: `docs/research-cache-write-pricing.md`. (feature-36, PR #69)

### Fixed — the Cost page counts models and ids one way
- **A merged model row listed the same id twice and the two id counts contradicted each other** ("Models used … 17 ids"
  in the window vs fewer in the all-time footer): the window rows from `/v1/overview` carry inference-profile ARNs,
  which the page shortened but never de-duplicated against the bare id, while `/v1/costs` is normalised by the API.
  `lib/model-names.ts` now applies the API's `normalizeModelId` rule before merging and exposes each row's distinct
  `ids`; the tile and the footer count models and ids by that one definition. No dollar or token figure changes.
  (qa F-PR66-001 / F-PR66-006 / F-PR67-001; feature-35, PR #68)

### Fixed — every figure reconciles with the one beside it (feature-34)
- **/roi:** monthly spend and the annual figure now share one day-count basis (365/window and 365/12), so monthly × 12
  reproduces the annual number exactly. Before, monthly used a 30.44-day month and the page showed a rounded ×12.17.
  The page now reads "× 365/N" instead of a rounded factor.
- **/latency By model:** series are ranked by invocations, and the busiest 12 get rows. Before, the Lambda kept the
  first 12 in ListMetrics order and silently dropped the rest. A last row holds the fleet total minus the listed rows,
  so the column adds up to the fleet figure. ListMetrics and GetMetricData now paginate, the latter in chunks of 500
  queries. The #64 note that blamed "a burst" is replaced.
- **/latency fleet tiles:** a line under the tiles states the account-wide invocation count, this tenant's share and
  the rest (other callers in the AWS account, such as CI agents). CloudWatch counts all of these; the Usage page does not.
- **/latency By project:** the panel states that per-project latency is Fast-only. The Glue table over the raw logs
  maps no response body, so Athena cannot read it.
- **Rate card:** Claude `fable-5-1`, `mythos-5-1`, `opus-5-5`, `sonnet-5-5` and `sonnet-5` get their own rows (AWS
  Price List, us-east-1, Global standard). They were priced at their family rates. **Cost is computed from stored
  tokens at read time, so this reprices history.** Measured on dev: the largest tenant's all-time total moves from
  $14,896.79 to $14,365.94 (−$530.85, −3.6%), mostly from `fable-5-1` cache reads, which fall from $1.00 to $0.25 per
  MTok. Across all tenants the total moves from $19,808.97 to $19,253.12. A test now fails if a row sits below a
  shorter key that would shadow it.
- **/dora banner:** "N PRs collected" becomes "N merged PRs stored for this repo since collection began, not only this
  window". The stored count matches a live count for all six repositories, so only the label changes.
- **/projects Full:** the panel states the live Athena − rollup difference in dollars and percent, instead of
  "slightly ahead". (feature-34, PR #67)

### Changed — DORA tables open on their top rows
- **The three long tables on DORA** — recent merged PRs, all tracked repositories, projects × cost — show their top
  10 rows with a "Show all N" control (and "Show top 10 of N" to fold back); tables with ten rows or fewer are
  unchanged. Repositories rank by merged PRs and projects by estimated spend — the value column each table is
  read for — and recent PRs stay newest first; each caption names the ordering and, when cut, how many rows are
  shown. Table standards 4 and 5 from the UX research, already applied to Cost and ROI, now reach DORA. No
  number changes, no API change. (feature-33, PR #66)

### Fixed — an agent run that explored nothing is no longer a green check (feature-32a)
- **UI QA agent:** four consecutive runs on #64 hit Bedrock `ServiceUnavailableException` before the agent
  explored anything, and `normalize_report` rewrote the `UNKNOWN` sentinel to `PASS` because the findings list
  was empty — a 2-minute, 358-character run came back **green**. Now: `UNKNOWN` is kept (the workflow's red
  path fires); a PASS with zero findings requires evidence of exploration (`pages_tested ≥ 1` or a
  non-trivial transcript) or the verdict is withheld; a stream that fails before any output is reported as
  "no transcript", not "partial"; the exploration invoke is retried twice when it produced nothing. **Tightens
  only; nothing loosens.**
- **Workflow:** one qa run per PR at a time (`concurrency` group, cancel-in-progress) — two pushes 29 s apart
  had run concurrently against one site and one harness.
- Outside this repo, same investigation: the QA harness execution role had never held Code Interpreter
  permissions (owner-authorised grant applied 2026-09-29), and Bedrock rejects the harness's large streaming
  requests on `global.anthropic.claude-fable-5` while small requests succeed — a harness model change is
  recommended to the owner.

### Changed — /latency says its fleet and per-model figures are separate series (feature-31)
- The "By model" panel now states that the rows and the fleet tiles are separate CloudWatch series that can
  briefly disagree after a burst, that profile-routed calls are not counted twice, and that the fleet series
  is the reference (qa F-PR63-001; verified fleet 4,240 == Σ per-model 4,240 over 7 days). Copy only.

### Added — every chart has a table twin
- **Chart | Table control on the four Recharts panels** — Usage "Token consumption over time", DORA "Merges to the
  default branch per week" and "Lead time per week", AI ROI "ROI components". Table view is the portal's standard
  `table.data` with a caption, unit-bearing headers, right-aligned figures formatted by the same `fmt*` helpers as
  the tiles (so a table cell equals the tooltip value), and `—` with an accessible label for gaps. The chart is
  unmounted while the table shows; the control is hidden in print. Closes chart standard 6 ("Tooltip never gates")
  from `docs/research-dashboard-ux.md`. `LatencyPage.tsx` is left for a follow-up now that feature-28 has landed.
  (feature-29, PR #63)

### Fixed — one over-counted day repaired; qa no longer files what the page already explains (feature-30)
- **2026-09-17 PROJDAY rollups** for the demo tenant carried +231 invocations / +12,380 input / +146,311
  output tokens more than the hourly rollups and the raw logs — the boundary day of feature-13's PROJDAY
  backfill, counted twice. Visible since #57 as a Usage-vs-Cost mismatch. Repaired by
  `backend/scripts/repair-projday-day.ts` (committed here; run 2026-09-24 with the owner's authorisation):
  it re-derives the day through the aggregator's own four-tier attribution, locates the surplus
  treatment-aware, gates every write on three assertions, and negative-ADDs the `untagged` rows only under a
  marker. Hourly == PROJDAY over 30 days afterwards, Δ 0/0/0.
- **UI QA agent:** a difference the page itself discloses and quantifies (e.g. "the $5.76 difference is
  traffic since the last rollup") is no longer filed as a finding — it had been filed three times as a LOW
  that reddened PRs under `QA_RED_ON: FAIL`. The rule says exactly when to file anyway (the disclosure cannot
  account for the gap, or the numbers contradict it) and requires quoting the disclosure. `QA_RED_ON` stays
  `FAIL`; this narrows one false positive, not the bar. Owner decision 2026-09-28.

### Added — latency per project, from the calls we already log (feature-28)
- **`/latency` gains a "By project" table.** Every logged Bedrock call carries
  `amazon-bedrock-invocationMetrics` (`invocationLatency`, `firstByteLatency`) in its response body; the
  aggregator now lifts those two numbers out and **discards the body** (the payload that once ran a 4 GB
  heap out of memory), folding them into count + sum + fixed-edge buckets on every rollup — hourly, per
  model, per project and per project-day. Because the rollups are already attributed to projects
  through the four existing tiers, latency is per project for free.
- **`GET /v1/latency` returns `projects`** — per-project mean/p50/p95 for e2e and first-byte over the
  window, read from the tenant's PROJDAY buckets. Percentiles off fixed buckets are **estimates**
  (`estimated: true`, exact only to a bucket's span; `openEnded` marks a lower bound, shown as `≥`), and
  the payload states what share of the window's calls carry a sample. The fleet CloudWatch figures
  remain the exact reference and sit above the table. `LatencyFn` gains read grants on the tenants and
  aggregates tables for this section only.
- **`backend/scripts/backfill-latency.ts`** adds latency to rollups written before this build: dry-run by
  default, `BACKFILL_UNTIL` (the aggregator deploy time) required, per-object claim/done markers so a
  re-run never double-counts and a crash mid-object is reported rather than hidden.

### Fixed — the ROI model diagram's footnotes no longer run under its result box
- On AI ROI, the "Adoption dip (J-curve …)", model-skeleton and method lines were drawn across the full
  width at the same height as the ROI result box, so the box covered them and the first line overflowed the
  SVG. They now sit below the box, the Adoption-dip sentence wraps, and the drawing is 36 units taller. Same
  words, same colours. Reported by the owner on the live page. (feature-19b, PR #59)

### Changed — the Cost page follows the portal's time range
- **Estimated Cost honours the header time-range picker** (`?window=7|30|90|mtd`) instead of being pinned
  to "All time". Its tiles and the Spend-by-model table now come from `/v1/overview` — the same PROJDAY
  rollups and rate card as Overview and By project — so the three pages give the same figure for the same
  range; the Estimated-spend tile carries the delta against the prior equal period and a daily sparkline.
  The all-time total stays as the footer line, from `/v1/costs`.
- **`GET /v1/overview` gains `byModel[].cacheSavingsUsd`** (additive) so cache savings can be windowed.
  Until the API is redeployed the Cost page shows "—" for that column and says why, rather than a false zero.
- **Overview's Budget tile names its source** whenever it shows a figure: "AWS Budgets billed spend — not the
  token estimate in the Spend tile" (qa on #55/#56: "$0.00 · On track" beside a spend of thousands).
- **Anomalies keeps one time-range control**: the in-feed "Show last 90 days" shortcut is gone; the header
  picker sets the window and the disclosure under the feed lists older detections (F-PR56R4-001 lineage).
  (feature-27, PR #57)

### Fixed — the CI QA loop now reports what it found
- **A failing QA report can no longer end the run green.** `qa_agent.py` publishes its `overall`
  verdict to `$GITHUB_OUTPUT`, and a new terminal workflow step fails the job when the loop has
  stopped (no auto-fix pushed) with an unclean report. Previously the QA step ran under
  `continue-on-error` and nothing read the verdict back, so "blocking findings remain, fewer than two
  stalls, nothing pushed" ended **green** — PRs #51, #52 and #53 each reached "all checks passed" over
  a report saying `overall: FAIL`. The job-level `QA_RED_ON` knob selects whether LOW findings redden
  the check (`FAIL`, the default) or only blocking ones (`BLOCKING`). An absent or unparseable verdict
  is red under both: "no report" must not read as "found nothing".
- **The Bug-Fix agent may only edit files the active intent plan names**, using a check that mirrors
  `sdlc_ci_gate.plan_covers` exactly, and refusing everything when no plan is readable. A patch
  outside the plan reddened `sdlc-gate` — the very kind of check the fix was meant to green — and
  needed hand-written reverts on #48 and #51. The commit step now stages exactly the agent's own
  patched-file list instead of `git add -- backend frontend infra`.
- **A finding that recurs across PRs is named as a repeat** in the bot's summary, with the statement
  that it needs its own intent chain. A finding no plan covers is refused every round, so one
  `/anomalies` copy defect was reported four times before anyone owned it.
- All three rules, and the failure each prevents, are written down in `AGENTS.md`.

### Changed — two pages state their counts so they cannot be read wrong
- **Projects:** each header tile now carries a source chip and a provenance line. With the Full
  (Athena) source selected, "Projects tracked" counts Athena rows while both totals stay on the
  per-model rollups — three tiles, two sources — which read as one dataset before.
- **Latency:** the fleet tiles say the first-byte sample set is *contained in* the end-to-end one and
  that the two do not add up. Adding them is the arithmetic error the QA agent itself made.
- **DORA / ROI project tables:** the per-project 30-day spend read **31** PROJDAY day-buckets
  (`projdayRange` subtracted the full window instead of `days − 1`), so it could exceed the Overview's
  figure for the same project and label by one day of spend. Now the same 30 buckets as the Overview.
- **Anomalies:** detections older than the selected window are listed behind a "Show N older
  detections" disclosure under the feed, instead of being counted in the empty state and unreachable.

### Changed — administration moves to Settings
- **New `/settings` page (admin group)** with the project registry and the DORA tracked-repository list,
  lifted from the By project and DORA pages with identical behaviour; non-admins see an explicit
  "Administrator access required" state. The two monitoring pages shed their admin forms (By project
  2 908 → 1 456 px, DORA 6 429 → 5 727 px) and point admins to Settings. Settings sits in the sidebar footer.
- `fmtInt` pins en-US grouping for plain counts; the Usage Invocations KPI was the last figure formatted
  with an unpinned `toLocaleString()`.

### Changed — one table and one chart on AI ROI; a readable Cost table
- **AI ROI:** the eighteen stacked per-project waterfalls (9 800 px) are replaced by one sortable table
  — project · spend/mo · break-even · evidence · value/yr · investment/yr · ROI or a short reason — and
  **one** detail panel for the selected project (waterfall, refusals, unit economics, assumptions).
  Selection lives in the URL (`?project=`) and is shared with the model diagram and the estimator.
- **Cost:** regional variants of a model (`us.` / `global.` / bare) merge into one row with region chips;
  friendly names with the raw ids as a secondary line; tokens in compact figures; units in headers;
  sortable columns with `aria-sort`; a totals row; rows under one cent folded behind a toggle; an
  "All time" footer naming the shared rate card. Still all-time from `/v1/costs` — windowing follows
  once `/v1/overview` is deployed and verified.
- **Anomalies:** at the 90-day window the empty state offers the guardrails page instead of a dead
  "Show last 90 days" button (qa F-PR51 LOW).

### Added — an Overview landing page, and the endpoint that makes it honest
- **`/` is now an Overview**: four tiles — Spend (window total, delta against the *named* prior equal
  period, sparkline), Budget (month-to-date billed vs limit with a status: On track · Forecast over ·
  Over · No billing data · Setup required), Anomalies (count in window, critical called out),
  Deployment frequency (median across synced repositories) — each with an ⓘ and a link to its page,
  plus a **What changed** table of the projects whose spend moved most. Overview is the first nav
  item; Token Usage moves to `/usage`. Follows the global time range.
- **`GET /v1/overview?window=7|30|90|mtd`** (new, additive): spend for the window and the prior equal
  period, a zero-filled daily series, per-model rows and per-project movers — one read of the daily
  per-project rollups priced with the Cost page's rate card, so Overview, Cost and Projects reconcile
  by construction. `coverage.partial` flags a comparison against an incomplete baseline. Month-to-date
  compares the elapsed days with the same span of the previous month.
- **`/v1/governance`** gains `billingDataAvailable` / `forecastAvailable` (additive) so "$0 because the
  account is not billed directly" is distinguishable from a real $0.
- No existing number or field changes.
### Fixed — a latency row that named an inference profile instead of a model
- **CloudWatch reports profile-routed invocations under the inference-profile id**, so the by-model
  table shipped in the previous entry rendered rows as opaque twelve-character strings
  (`c5xf7omvk87g`) as if those were model names. The UI qa agent caught it on the feature's own PR.
  `resolveLabel()` now maps the id back to the model behind the profile via
  `bedrock:ListInferenceProfiles`, and the row carries `via: 'inference-profile'` plus the profile
  name and the resolved model, so the page shows what was resolved rather than implying the dimension
  said it.
- **It refuses to guess in the two cases where guessing would be a fabrication.** A profile that fans
  out to several distinct models keeps the profile's own name and claims no model — the latency in that
  row is a mixture, so naming one of them would be wrong, and a unit test asserts `resolvedModel` stays
  absent. A profile that cannot be found keeps the raw id, which is at least literally what CloudWatch
  reported.
- **The list call is best-effort by requirement.** Denial, throttle or transport failure degrades to
  raw ids and leaves every other field untouched: a labelling aid must not be able to fail a metrics
  read. `LatencyFn`'s IAM therefore gains exactly one action, `bedrock:ListInferenceProfiles` — still
  no table grant of any kind.
- Same disambiguator fix on the page: two rows for one model (reached directly and through a profile)
  are separated by their actual route instead of both being reported as `direct`.

### Added — model-hop latency, with the chain drawn honestly rather than drawn complete
- **`GET /v1/latency?window=1|7|30`** and a `/latency` page. p50/p95/p99 plus sample counts for
  end-to-end `InvocationLatency` and `TimeToFirstToken`, fleet-wide and per `ModelId`, read from
  CloudWatch `AWS/Bedrock`. Percentiles come from CloudWatch's own statistics rather than being
  recomputed from datapoints we fetched.
- **`LatencyFn` is granted `cloudwatch:GetMetricData` + `cloudwatch:ListMetrics` and nothing else** —
  no table access of any kind, because these metrics carry no tenant, project or user dimension. That
  same absence is why the response and the page both state the scope is account-level and fleet-wide;
  per-project latency needs the invocation logs and is **not** built here.
- **Only two of the five hops in the request chain are measurable, and the page says so structurally,
  not in a footnote.** `hopModel()` is the single definition of the chain (developer IDE/CLI → LLM
  gateway → Bedrock time-to-first-byte → Bedrock streaming → Guardrails) and of each hop's
  observability. Measured hops carry a number and proportional width; unmeasured hops are drawn dark,
  carry no number, and name what you would have to instrument (Claude Code OpenTelemetry export,
  LiteLLM Prometheus histograms, Converse `trace.guardrailProcessingLatency`). A hop marked
  `unmeasured` is forbidden from carrying a metric and a unit test asserts it, so sizing a dark hop
  later would require deleting a test.
- **The generation segment is `e2e − ttft` per percentile and is labelled `derived` everywhere it
  appears.** Percentile arithmetic is not valid arithmetic; the shape is useful and the label is the
  only thing keeping the number from being a fabrication.
- **Percentiles say whether they are exact.** CloudWatch computes each percentile inside its own
  period bucket, and a window-length period does not guarantee a single bucket back. Where several
  come back they are collapsed to a sample-count-weighted mean and flagged `approximated`; an
  unflagged value is exact for the window. Observed live: 7 days returns one bucket, 30 days does not.
- **Streaming coverage is disclosed at the number**, because non-streaming calls publish no
  time-to-first-token at all, so its sample count is legitimately lower than end-to-end's.
- **No productivity claim anywhere on the page or in the payload.** The research behind this feature
  found no surviving evidence linking per-request latency to developer output, so latency is reported
  as a service characteristic only. Evidence: `docs/research-latency-measurement.md`.
- 21 new cases in `backend/lambdas/api/latency.test.ts` over the three pure functions
  (`deriveGeneration`, `combineBuckets`, `hopModel`). API endpoint count 22 → 23.

### Fixed — every security alert we had ever written was unreachable from the feed built to show it
- **The anomalies table had one reader and two writers that disagreed about its primary key, on both
  halves.** `anomaly-response/index.ts` wrote `pk = TENANT#<tenant>#ANOMALY` with a bare
  `<eventTime>#<type>#<sourceIp>` sort key; the only reader, `GET /v1/anomalies`, queries
  `pk = TENANT#<tenant>` with `begins_with(sk, 'ANOMALY#')`. Nothing in the stack could report it: a
  `PutItem` with the wrong key succeeds, and a `Query` that matches nothing returns an empty page —
  which is exactly what "no anomalies detected" looks like.
- **`backend/lambdas/shared/anomaly-key.ts` is now the single definition** (`ANOMALY_SK_PREFIX`,
  `anomalyPk()`, `anomalySk()`), used by all three call sites — both writers and the reader.
  `ingestion/aggregator.ts` (the feature-14 runaway-spend writer) was already correct but only via a
  duplicated literal, so it was switched too: a third independent spelling of the key is the hazard
  that produced the defect. `detectedAt` leads the sort key, so lexicographic order is chronological
  and the reader's existing `ScanIndexForward: false` stays newest-first with no secondary index.
  Keys are deterministic, so a re-processed batch re-puts rather than duplicating an alert.
  16 new cases in `backend/lambdas/shared/anomaly-key.test.ts`.
- **The rows already written were repaired, not written off.** `backend/scripts/migrate-anomaly-keys.ts`
  is one-off, dry-run by default (`--apply` required to write); each replacement is a `Put` under
  `attribute_not_exists(pk)` and the legacy row is deleted only after the replacement is confirmed, so
  a mid-run crash leaves a duplicate — visible, cleanable — rather than a lost alert. On dev: 3 items,
  `0 already readable, 3 to rewrite` (two `AccessDenied`, one `OffHoursUsage` — every alert the table
  held), then `3 migrated`, then 3 of 3 returned by the **reader's own** key condition, and a clean
  re-run. The script is not standing tooling: standing tooling for a broken shape keeps it alive.
- **The browser render of the Anomalies page was not read this round** — verification was at the
  API/table layer via the reader's key condition.
- **`fmtTokens` scales past `M` to `B` and `T`** with a pinned `en-US` locale, closing F-1201 (and five
  further recurrences), where a cumulative cache-read token total rendered as `16215.23M` — four digits
  of mantissa with no thousands separator.
- No change to anomaly detection, to the `/v1/anomalies` contract, or to any table, index or GSI.

### Fixed — two qa findings that kept recurring across PRs
- **By Project (Fast):** the "Total est. cost" foot now discloses that rows are shown to the cent, so
  their sum can differ from the authoritative rollup total by a few cents (F-1706). The header value
  is unchanged.
- **AI ROI:** the "nothing shipped in this window" refusal now says *from this project's linked
  repositories* — DORA's page shows one selected repository, ROI counts the project's own repos, and
  the sentence never said so (F-1707). On the model diagram the reason is no longer only a clipped
  line: the full sentence is printed under the legend and carried as an SVG title.

### Changed — one time range for the whole portal
- **A single 7 / 30 / 90 days / month-to-date control in the top bar**, carried in the URL (`?window=`)
  so a link reproduces the view. Usage, DORA, ROI and Anomalies follow it; every page states the range
  it is actually showing. Pages that cannot honour a window coerce to the nearest one they can and say
  so ("month to date not available here"); Cost, Projects and Governance show their fixed period as a
  caption instead of a control.
- **Usage** now has 30/90-day and month-to-date views (daily buckets past two weeks). **Anomalies**
  filters its feed to the range and its empty state offers a way out (widen the window, or go to the
  guardrails) instead of an emoji.
- **DORA and ROI charts on the validated theme**: human/AI cohorts in blue/orange (the old pair failed
  the colour-vision check), the ROI waterfall on the diverging pair, hairline solid grids, one
  chrome definition instead of four copies.
- No API or computed-value change.
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
