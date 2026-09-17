# Feature 14 — AI-coding ROI page (cost × DORA × manpower)

| | |
|---|---|
| **Intent** | intent/roi-page/ (accepted chain; plan base-bound to the post-#39 merge base) |
| **Branch / PR** | `feat/roi-page` → #40 |
| **Date** | 2026-09-17 |
| **Environment** | `dev` (us-east-1) — live stacks, live API, live CloudFront site, real data |
| **Result** | **PASS** |

## Scope

A `/roi` sub-page answering "is the AI coding spend worth it?" from this portal's own measured
data: per-project ROI over PROJDAY spend rollups × per-repo DORA metrics × customer-owned labor
assumptions, a minimal-assumption break-even view, reference-class forward budgeting, a
kill-fast portfolio signal, and a runaway-spend guard on the ingestion path. New read-only
Lambda (`api/roi.ts`), pure model (`api/roi-calc.ts`), org-wide + per-project ROI assumptions on
the registry, and `detectRunaways` in the log parser. Model contract and citations:
`docs/research-roi-model.md`; the customer-facing write-up is `docs/ROI_METHODOLOGY.md`.

## Unit tests / gates

- backend jest **158/158** (18 suites; +26 for this feature: annualization applies to rate-like
  terms but not to training or the J-curve, honest negative ROI, stability-as-a-cost, the −100%
  net-time-saved floor, the revenue-impact clamp, zero-investment and zero-delivery windows, the
  three composite refusals from both sides, percentile bands and their <4-week refusal,
  consecutive-only out-of-sample kill-fast, ISO-week folding across a month boundary with
  per-model pricing, runaway threshold boundaries, registry ROI validation) · `tsc --noEmit` ✅
- frontend `tsc && vite build` ✅ · infra `cdk synth --context env=ci` ✅ (10 stacks)
- SDLC CI gate dry-run ✅ — 17 source files, every one named in the accepted plan, `Accepted-for`
  binding matches the merge base

## Live validation (dev, real data)

| Check | Result |
|---|---|
| `Tums-dev-Api` deployed with `RoiFn` (512 MB / 20 s, read-only grants on tenants + aggregates + dora) | ✅ |
| `GET /v1/roi/projects?window=90` returns 21 registry projects with per-project spend, DORA sample, components, break-even, bands and kill-fast state | ✅ |
| `PUT` then `GET /v1/projects/registry/defaults` — org defaults written and read back unchanged (admin-only) | ✅ |
| Per-project assumptions accepted by the registry upsert (`teamSize` 2, `loadedCostPerYear` 200000, `category` product) and reflected as `assumptionsSource: project` | ✅ |
| Composite arithmetic hand-checked against the API response (see the table below) | ✅ |
| Forward estimator hand-checked: budget P50 = per-PR P50 × expected PRs; projected break-even = budget ÷ loaded hourly rate | ✅ |
| Input guards: `window=7` → 400 with the reason, `prsPerMonth=0` → 400, unknown reference → 404, no token → 401 | ✅ |
| Bands correctly refused for every project with fewer than 4 weeks of history (17 of 21); the two with 5 and 7 weeks produce P25/P50/P90 | ✅ |
| Runaway guard end-to-end: real invocation logs → `detectRunaways` → anomalies table → `GET /v1/anomalies` → Anomalies page, message carrying request id, cost, model and project | ✅ |
| Frontend deployed; `/roi` route, nav entry and page render against the live API | ✅ |

### Hand-checked composite (the one project with its own staffing)

| Quantity | API | By hand |
|---|---|---|
| Annualization factor (90-day window) | 4.06 | 365 ÷ 90 = 4.056 |
| Time saved (value) | $50,000 | 2 × 200,000 × 0.125 |
| AI spend (investment, annualized) | $1,508 | 371.84 × 4.056 |
| Training + J-curve (one-time) | $600 + $15,000 | 300 × 2; 2 × 200,000 × 0.15 × 0.25 |
| ROI | +192.3% | (50,000 − 17,108) ÷ 17,108 |
| Payback | 4.1 months | 17,108 ÷ 50,000 × 12 |
| Break-even | 1.3 h/mo, 0.4% capacity | 125.77 ÷ (200,000 ÷ 2080); ÷ (2 × 173.33) |

## Defects found by reading live data, and fixed

The unit tests were green and the model still produced indefensible headlines on real data. All
three fixes refuse the composite rather than inventing or capping a number, and all three keep
the components, the measured spend and the break-even view visible.

1. **Zero-delivery projects reported positive ROI** (+49.8%, +86.5%, +145.5%, +344.4% against 0
   merged PRs and 0 deployments), because the time-saved term is assumption-only. A window with
   no shipped output now gets no headline.
2. **A project showed 1,874,900% ROI** on $0.05/month of spend — a denominator approaching zero.
   Investment below one engineer-hour per month of loaded cost is now refused. The floor is
   expressed in the model's own units rather than as a magic constant.
3. **Every project borrowed the same default team size**, so one team's annual saving was claimed
   once per project and a portfolio total became a multiple of a placeholder. The composite now
   requires this project's own `teamSize` and `loadedCostPerYear`.

Frontend fixes from the same live read: a duplicated "Not computed:" prefix on self-describing
refusal strings; the portfolio quadrant caption now states that projects whose ROI is refused
plot at the base bubble size; and the break-even capacity share is annotated when the team size
behind it is a shared default, since the hours figure needs only an org-level hourly rate but
the capacity share does not.

## Findings from the automated UI QA agent on the PR, and what they turned out to be

The AgentCore UI QA agent drove the deployed branch through all seven pages: login PASS, 0 console
errors, 0 failed network requests, and cross-page totals reconciling (Cost header $13,744.94 =
By Project header, row sums within $0.02, Athena scan ~60 s with the rollup-lag banner explaining
a $1.21 gap). It raised two findings on the new page.

| ID | Verdict | Outcome |
|---|---|---|
| F-1002 (LOW) — the weekly `$` band renders an em-dash on most cards despite non-zero spend and a stated week count | **Correct** | Fixed. Refusing a band under four weeks is deliberate, but a bare em-dash reads as zero or as broken. It now says "needs 4+ weeks of history (has 2)". |
| F-1001 (MEDIUM, blocking) — the "Assumptions…" buttons are unresponsive | **False positive, real underlying cause** | The agent's own screenshot `10-roi-assumptions-broken.png` shows the drawer fully open with all six rows, org-default badges, override inputs and Save button. The drawer works. |

F-1001 is worth recording rather than dismissing, because the reason the agent got it wrong is a
genuine defect. The drawer is a conditionally rendered `div` carrying no accessible state, so
clicking a second card's button — which closes the first and opens the second, leaving total page
text roughly unchanged — is indistinguishable from clicking a dead button. A screen reader hits
exactly the same wall. The toggle now carries `aria-expanded` and `aria-controls`, and the drawer
is a labelled region with the id the button references. The click logic was already correct and
was left alone.

The lesson is the same one this feature keeps producing: the failure was in what the page
*disclosed about itself*, not in what it computed.

## Pre-existing quirk recorded, deliberately not fixed

`backend/lambdas/anomaly-response/index.ts` writes items with `pk = TENANT#<tenant>#ANOMALY`,
while the reader `backend/lambdas/api/anomalies.ts` queries `pk = TENANT#<tenant>` with
`begins_with(sk, 'ANOMALY#')`. Those two shapes never meet, so items from the automated-response
path cannot appear on the Anomalies page. The runaway guard therefore follows the **reader's**
shape and its items do render. Fixing the writer is out of this feature's scope and belongs with
the automation path that owns it.

## Runaway-guard validation method (non-destructive)

The rollup upserts use DynamoDB `ADD`, so re-processing log objects would double-count real
usage. Rather than rewind the live watermark, the real aggregator handler was run once against
the live log bucket with `AGGREGATES_TABLE` pointed at a throwaway table, `ANOMALIES_TABLE`
pointed at the live table, and `RUNAWAY_REQUEST_USD` lowered to 0.01. Live rollups were
therefore untouched. The synthetic anomaly items were deleted afterwards (1,722 removed, the 3
unrelated anomalies left in place), the throwaway table was dropped, and the deployed threshold
was confirmed still at its $50 default — it was never changed, because the lowered value existed
only in the local run's environment.

## Operator steps

Set org-wide ROI defaults once (Assumptions drawer, admin), then per-project `teamSize` and
loaded cost for each project that should show a composite ROI. Until a project has its own
staffing it shows break-even only, by design. `runawayRequestUsd` is configurable per
environment (`0` disables the guard).

## Verdict

**PASS.** The model computes correctly where the evidence supports it and refuses where it does
not, with every refusal stated on the page. The three integrity defects that mattered were
invisible to the unit tests and only surfaced by reading real per-project output, which is the
main lesson from this feature.
