# Feature 37 — Cache-cost truth: copy, record, guards

- **Chain:** `intent/cache-cost-truth/` · **Branch:** `feat/cache-cost-truth` off `main@daf6df6` (post-#69, feature-36) · **PR:** TBD
- **Origin:** the 2026-10 cache-write pricing omission (`docs/incidents/2026-10-cache-write-omission.md`). Feature-36 fixed the
  pricing; this chain fixes what the product *says*, records why it happened, and adds the checks that would have caught it.
- **Date:** 2026-10-08
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **The guards work as designed, proven on both trees.** On the pre-fix tree (`ca0ba29`) the two new suites fail on exactly
  the six cases that describe the omission — cache-write unpriced, the MODEL writer and both per-project aggregates missing the
  counter — and on feature-36's tree every one of them passes. A guard that is red for the right reasons before the fix and
  green after it is the only kind worth shipping.
- **The drift script found something real within two days of being written.** On 2026-10-06 the card matched the AWS Price
  List on all 33 existing rates. On 2026-10-08 the same script reported Claude Sonnet 5.5 cache read at **$0.10/M** (0.05×
  input, the Opus 5.5 exception class) against the card's $0.20 — AWS changed it between the two runs. Reported to the rate-card
  owner; this is the exact failure mode (a hand copy of a public table drifting silently) the script exists for.
- **"Saved by prompt caching" was a half-truth; "Net effect" is the whole one.** The tile now reads read-savings minus
  write-premium and shows both terms beside it; a workload that writes more than it re-reads sees a negative number and a
  "caching cost more than it saved" status, instead of a reassuring green saving.
- **Two reviewer findings on feature-36 came out of this chain's guards** before it merged: gpt-5.6-sol's cache-write rate was
  0 (Bedrock bills 1.25×; corrected to $1.5625/M), and the superseded `backfill-projday.ts` still wrote four counters (now
  marked superseded). Reported to the ingestion owner and fixed in #69.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/pricing-completeness.test.ts` | new — token kinds derived from `parse.ts`; each must price > 0 alone and on every card row, or be allow-listed (`UNPRICED_BY_DESIGN` empty; `CACHE_WRITE_FREE` = gpt-5, nova-micro with the published rule); cache write ≥ 1.25× input |
| `backend/lambdas/ingestion/rollup-fields.test.ts` | new — static: each `upsert*` ADD list ⊇ its aggregate's counters (resolves shared string constants such as `CW_CLAUSE`); Project/ProjectDay aggregates carry UsageAggregate's counter set; `repair-projday-day.ts` COUNTERS complete; `backfill-projday.ts` complete or marked superseded |
| `backend/scripts/check-rate-card.ts` | new — Price List (`AmazonBedrockFoundationModels`, model from `servicename`, kind/TTL/route from `usagetype`) vs `RATE_CARD`; `ok / DRIFT / UNPRICED / NOT IN LIST`; `--json`, `--route`; exit 1 on drift |
| `backend/lambdas/api/overview-calc.ts` + test | `byModel[].cacheNetUsd` (Σ of `computeModelCost().cacheNetUsd`); `tokensOf` counts cache writes so Overview's token figure = Usage's; 3 new assertions incl. a negative-net case |
| `frontend/src/api/client.ts` | `byModel[].cacheNetUsd?` |
| `frontend/src/pages/CostsPage.tsx` | tile → "Net effect of prompt caching" (signed, warn status when negative, definition shows reads saved − write premium and writes billed); column "Cache savings (USD)" → "Cache net (USD)" sorted on net; pricing note names the ~9 % lower bound and the runbook |
| `frontend/src/pages/UsagePage.tsx` | cache tile foot: reads 0.1×, writes 1.25× / 2× |
| `frontend/src/pages/OverviewPage.tsx` | Spend definition counts four kinds + lower-bound note; freshness line "Latest logged call … · rollups last ran …" |
| `frontend/src/pages/ProjectsPage.tsx` | "reads and writes are priced but not counted"; freshness wording |
| `frontend/src/lib/help-content.ts` | `overview.spend`, `usage.input-tokens`, `usage.cache-tokens`, `cost.estimated-spend`, `cost.cache-read-tokens` rewritten; `cost.cache-net`, `cost.cache-write-tokens` added; `cost.cache-savings` removed |
| Docs | `README.md`, `docs/GOVERNANCE_FAQ.md`, `docs/ROADMAP.md`, `docs/VERIFICATION.md`, `docs/ARCHITECTURE.md` corrected; `docs/incidents/2026-10-cache-write-omission.md`, `docs/RECONCILIATION.md` new |
| `backend/package.json` | `@aws-sdk/client-pricing` dev dependency |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` — the two guard suites + overview-calc | 31 / 31 on feature-36's tree (`97ebfc1`) |
| Same suites on pre-fix `ca0ba29` | 6 red of 16: `cacheWriteTokens` unpriced (×3 assertions), `upsertModelRollup` missing the counter, `ProjectAggregate` and `ProjectDayAggregate` short of `UsageAggregate` — the omission, exactly |
| Backend `tsc --noEmit` | PASS |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `check-rate-card.ts` (live, 2026-10-08) | 1 DRIFT (Sonnet 5.5 cache read, see above), 0 UNPRICED, 0 card errors |
| `sdlc_ci_gate.py --require-active` | _to run against the post-#69 main at push time_ |

## Local render (build on :4177 against the live dev API = #69's deploy, owner's session, 2026-10-09)
| Check | Result |
|---|---|
| Cost tiles | Estimated spend **$3,785.95** (30 d; ▼ −67 % vs 08-11 – 09-09 — the first window priced with cache writes against one that was not); **"Net effect of prompt caching" = "—"** with "not available for this time range until the API is redeployed with the net figure" — correct, the live `OverviewFn` predates this chain's `cacheNetUsd`; Models used 8 (13 ids); Cache-read tokens 2.39B "billed at each model's cache-read rate (0.025×–0.1× input)" |
| Cost table | columns Model · Input · Output · Cache-read · Cache-write · Cache-read (USD) · Cache-write (USD) · **Cache net (USD)** · Est. cost; totals 15.17M · 11.23M · 2.39B · 231.01M · **$1,022.52 · $2,342.89 · — · $3,785.95**; the net column reads "—" rather than falling back to the gross saving (fixed during this check — it had shown $16,117.84 under a "net" heading) |
| Pricing note | names the four kinds, the per-model cache-read rate, 1.25× / 2× writes, the ~9 % lower bound and `docs/RECONCILIATION.md` |
| Overview | Spend $3,785.95 = Cost; freshness line **"Latest logged call 08:51 UTC (5 min ago) · rollups last ran 08:51 UTC (5 min ago) · new logs are rolled up every 15 minutes"** — both timestamps from `/v1/overview` |
| Overview token figure | live API still returns `spend.tokens` = in + out + cache-read (2.41B) while Σ byModel incl. cache-write = 2.64B — the gap is exactly the cache-write tokens; closes when the Api is redeployed with this chain's `tokensOf` |
| Usage | Prompt-cache tile 2.62B; foot "reads 0.1× input, writes 1.25× (2× for 1-hour)"; the word "discount" no longer appears on the page |
| Console errors | 0 across Cost, Overview, Usage, Projects |

**Deploy needed after merge (owner authorisation):** `Tums-dev-Api` — `OverviewFn` only (`cacheNetUsd` per model; `spend.tokens`
counts cache writes). Until then the net tile/column read "—" and say why.

## Live (after push — qa)
_To be filled._
