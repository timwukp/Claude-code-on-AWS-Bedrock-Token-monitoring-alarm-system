# Feature 35 — Cost page id consistency

- **Chain:** `intent/cost-id-consistency/` · **Branch:** `feat/cost-id-consistency` off `main@1ce4726` (post-#67) · **PR:** #68
- **Origin:** qa F-PR66-001 (MEDIUM, "34 ids" in the window vs "28 model ids" all-time), F-PR66-006 and F-PR67-001
  (LOW, a merged row lists the same id twice; "Models used 11 · 17 ids" counts the repeats — 15 distinct).
- **Date:** 2026-10-02
- **Verdict:** PASS on gates, the owner's local review and qa (no finding on the Cost page's ids; four findings elsewhere, triaged below).

## What this report has to say plainly
- **One defect, three findings.** The window rows (`/v1/overview.byModel`) carry inference-profile ARNs; the page
  shortened them with `split('/').pop()` but never de-duplicated against the bare id, so an ARN and the id it routes
  counted as two — in the row's id line and in the tile. The all-time footer came from `/v1/costs`, which the API
  normalises and merges, so the two counts could not agree.
- **Fixed where both views can share it.** `lib/model-names.ts` now applies the API's own `normalizeModelId` rule
  before grouping and exposes each merged row's distinct `ids`; `CostsPage` counts models and ids from that one
  function for the tile and the footer alike. **No dollar or token figure changes** — grouping by canonical model
  already summed the duplicate rows correctly; only the id listing and the counts were wrong.
- **Correction on the record.** In the feature-33 report I attributed the DORA "53 collected vs 56 merges" finding to
  a stale `prCount` snapshot. That was wrong: stored and live counts match on every repo; qa compared one repo's
  all-time count with a two-repo 30-day sum. #67 relabelled the banner; nothing in the store needed fixing.

## Scope
| File | Change |
|---|---|
| `frontend/src/lib/model-names.ts` | `normalizeModelId` (mirrors `cost-calc.ts`); `mergeModelRows` normalises before `parseModelId` and adds `ids: string[]` (distinct); `countModelIds` |
| `frontend/src/pages/CostsPage.tsx` | rows and id lines from the shared merge (local `split('/').pop()` removed); "Models used" definition counts distinct ids; footer "across N models (M ids, counted the same way as the tile above)" |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 2 source files, named in the plan |

## Local render (build served on :4177, live dev API)
Reviewed by the owner in their own browser on 2026-10-05 against the live page: no id repeated in any row; tile and
footer counts consistent across 7 / 30 / 90 / mtd; dollar and token figures unchanged from live main. Owner's go: "ok 推".
Gates (`tsc`, `vite build`, SDLC gate) PASS as above.

## Live — qa on `c75a885` (10/10 pages, 4 findings, none on the Cost id fix)
| Finding | Verdict | Facts |
|---|---|---|
| F-PR68-001 MEDIUM — "rollups ~16 h stale although the UI states they refresh every 15 minutes" | **Misreading invited by our copy; aggregator healthy.** Not this PR | CloudWatch for `AggregatorFn`: it ran every 15 min all night and logged "Processed 0 objects" from 09:09 UTC to 01:06 UTC — **no new Bedrock invocation logs arrived** (a quiet Saturday night), so there was nothing to roll up. At 01:21 it processed 1 object and at 01:36 188 objects (the qa run's own calls); watermark now `2026-10-05T01:36:35Z`. The footer's "Data as of" is the timestamp of the **newest processed log object** — i.e. the last traffic — not the last run, so "16 h ago · refresh every 15 minutes" read as a contradiction. Fix (follow-up `rollup-freshness`, Overview/Projects copy — feature-23 lineage, mine): say "latest logged call HH:MM (N ago) · new logs are rolled up every 15 minutes", and expose the aggregator's last-run time alongside (needs `lastRunAt` on the watermark + `/v1/overview` — ingestion owner) |
| F-PR68-002 LOW — "Unknown <id>" rows, one priced $0.00, zero-token ids in "Models used" | Not this PR | Three application-inference-profile ids the registry cannot resolve (`pj21d310s69b`, `12jjg23nnft1`, `wn91zu880oo3`); pricing is the rate card / profile-resolution path (ingestion + cost-calc). The id-count part of this PR counts distinct ids correctly; whether zero-usage rows should be dropped from `/v1/overview.byModel` (as `/v1/costs` already does) is a one-line backend filter — flagged to the ingestion owner |
| F-PR68-003 LOW — Latency by-project "untagged" exactly 10,000 calls, only two projects | Not this PR | A query cap in the latency-projects read — latency owner |
| F-PR68-004 LOW — `/v1/quotas` 6–7 s, "also fetched on Settings" | Not this PR | Only `UsagePage.tsx` calls `api.quotas()`; the Settings timing is the in-flight request carried across the SPA navigation. The 6 s itself is the quotas Lambda (Service Quotas + CloudWatch) — backend |
| Cost id fix | **no finding**; F-PR67-001 not re-filed | |
