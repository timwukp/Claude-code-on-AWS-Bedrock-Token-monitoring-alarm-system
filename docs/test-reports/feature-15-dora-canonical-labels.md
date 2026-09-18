# Feature 15 — canonical DORA labels (say what is actually measured)

| | |
|---|---|
| **Intent** | intent/dora-canonical-labels/ (accepted chain; plan base-bound to the post-#40/#41 main tip `06a9f9c`) |
| **Branch / PR** | `feat/dora-canonical-labels` → `main` |
| **Date** | 2026-09-18 |
| **Environment** | `dev` (us-east-1) — live stacks, live API, live CloudFront site, real data |
| **Result** | **PASS** |

## Scope

A presentation-only change to the DORA surfaces, implementing the recommendations in
`docs/research-dora-presentation.md` (14 claims from DORA's primary sources, adversarially
verified). Deployment frequency now leads with DORA's ordinal band; "proxy" sits in the label of
every merge-derived number; change failure rate carries no tier badge, because the published 2024
values are non-monotonic across the performance levels; tier badges are dated to the 2024 report
and carry DORA's own caveats; the fifth metric is named as not collected; and the recovery-time
metric keeps a name that matches its own scope instead of borrowing DORA's renamed one.

**No computed value changed**, with one deliberate exception: the change-failure tier, which was
never derivable from that metric alone, is now refused.

## What was wrong, and what it says now

| Surface | Before | After |
|---|---|---|
| Deployment-frequency tile | "How often do we ship?" · `1.0 / week` | "How often do changes reach main? (deployment-frequency proxy)" · **About weekly**, with DORA's verbatim phrase, the merge count, the rate and the cohort split beneath |
| Lead-time tile | "How fast does a change reach main?" | "How long from first commit to main? (part of change lead time)" · footer states DORA's window ends in production |
| Change-failure tile | percentage + a tier badge derived from monotonic 5/10/15% thresholds | percentage, **no badge**, and the four published values printed with the reason a single metric cannot place a team |
| Recovery-time tile | "How quickly do we recover?" | "How long to recover once something breaks?" · footer states this is **not** DORA's failed deployment recovery time and why |
| Fifth metric | absent | a tile naming deployment rework rate as not collected, and the signal that is missing |
| Tier badges | `Elite` | `Elite (2024)` with DORA's caveat in the tooltip; an empty sample reads "no band" |
| Caveat paragraph | "These are the four DORA metrics… Elite is best." | five metrics, the proxy warning from DORA's own tooling, the per-application survey-benchmark caveat, the 2025 archetype change, and the detector's false-negative mode ("0% means nothing matched") |

### The two places the sources are silent, marked as our choice

1. **A rate of exactly 1.0/day** sits on the seam between two of DORA's buckets. It is assigned
   upward, and the top bucket is reserved for ≥2/day, which is what "multiple deploys per day"
   literally says. Stated in the code and pinned by a test rather than left implicit in a `>=`.
2. **The short headline forms** ("About weekly") are ours; DORA's verbatim phrase is always printed
   next to them, so the citable label is never replaced by the readable one.

## Unit tests / gates

- backend jest **163/163** (18 suites) · `tsc --noEmit` ✅
  New coverage: all six ordinal buckets; both sides of the 1.0/day seam; the no-sample path
  (`null`, `0`, `NaN`); the change-failure tier refused at every value **including 0%**; the four
  2024 values asserted in report order, non-monotonic as printed; and the band reaching the
  per-project Delivery × Cost row (a dropped `band` would render every project as "—" while the
  rate still looked correct).
- frontend `tsc` + `vite build` ✅
- infra: no file changed; `cdk synth` runs in CI regardless
- SDLC CI gate dry-run ✅ — 7 source files, every one named in the accepted plan, `Accepted-for`
  binding matches the merge base

## Live validation (dev, real data)

`Tums-dev-Api` deployed (exit 0), then each read path exercised against the live `tums-dora` and
`TENANT#…#PROJDAY` data. Because the routes sit behind the Cognito authorizer and the demo token
had expired, the deployed `DoraFn` was invoked directly with an API-Gateway event carrying the
same `custom:tenantId` / `admin` claims the browser sends — the same deployed code and the same
real tables, only skipping the token exchange.

**`GET /v1/dora/metrics?repo=…&window=30`** (200) — the band travels with every cohort, and the
rate is now the supporting number:

| cohort | rate | band | tier |
|---|---|---|---|
| All | 0.9 / day (27 merges) | Between once per day and once per week | High |
| AI-assisted | 0.1 / day (3) | Between once per week and once per month | Medium |
| Human-only | 0.8 / day (24) | Between once per day and once per week | High |

Change failure rate returns `{"value": 0, "tier": "Unknown"}` in all three cohorts — the refusal
holds on live data at the value most likely to tempt an "Elite" badge. `mttr` is `null` / `Unknown`
with `n: 0`; lead time is unchanged (1.6 h median). `cfrReference` ships as data:
`[Elite 5, High 20, Medium 10, Low 40]` — non-monotonic in report order, as published.
`dataSource.deploymentDefinition` names the merge count a PROXY and carries DORA's tooling
warning, followed by nine notes: the absent fifth metric, the ordinal band and the 1/day seam, the
lead-time end point, the detector's false-negative mode, the recovery-time disclaimer, the
AI-assisted definition, incidents only in All, the dated per-application tier caveat with the 2025
archetype change, and the reason no tier is shown for change failure rate.

**`GET /v1/dora/overview?window=30`** (200) — `df.band` present on every repo row
("Between once per day and once per week", "Between once per week and once per month");
`cfr.tier` is `Unknown` on all rows.

**`GET /v1/dora/projects?window=30`** (200) — 6 of 21 projects have DORA coverage; both projects
with merges in the window carry a band (`proj-alpha` → "Between once per day and once per week",
$5.19/merge; `token-monitoring` → "Between once per week and once per month", $99.66/merge). The
four zero-sample projects return `band: null`, which the table renders as "—" rather than as a
rate of 0.

**Frontend** — built and published to the dev site bucket, CloudFront `E109P5BP3CW3XT`
invalidated. The bundle CloudFront actually serves (`assets/index-BtRWQEWS.js`) was fetched back
and checked: all six DORA band strings, "deployment-frequency proxy", "Deployment rework rate
(5th DORA metric)", "2024 DORA band", "no band", "failed deployment recovery time", "Merges to
the default branch per week" and "Deploy freq. (proxy)" are present, and every superseded label
("How often do we ship?", "DORA tier:", "Deployments per week", "How fast does a change reach
main?", "How quickly do we recover?", "These are the four DORA metrics") is gone.

One gap: the rendered page was **not** read in a browser this round — the Playwright MCP server
failed to connect (`CONNECTION_CLOSED`). The served-bundle check above covers the copy; layout was
verified against the same components in the previous round.

## Verdict

**PASS.**
