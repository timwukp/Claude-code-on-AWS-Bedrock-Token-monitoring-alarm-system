# Feature 42 — Cache churn, one bill panel, unpriced badges, honest drift checks (Chain B of the gateway study)

- **Chain:** `intent/unpriced-visibility-and-churn/` · **Branch:** `feat/unpriced-visibility-and-churn` off `main@e08ae19` (post-#74) · **PR:** #75
- **Origin:** plan `floating-enchanting-kahan` (approved 2026-10-14) Chain B; items #2, #8, #9 of the LLM-gateway study plus three
  qa leftovers from #73 on pages this chain owns.
- **Date:** 2026-10-23
- **Verdict:** PASS on gates; local render and live via qa recorded below.

## What this report has to say plainly
- **Built ahead, rebased twice without losing anything.** The frontend half was written on 2026-10-14 against the agreed field
  contract and parked; it was rebased onto #73 (bill shape changed from "Mantle estimate" to "bill vs logged" — the copy
  followed) and onto #74 (the peer shipped its own `UnpricedNote` and a minimal bill panel — this chain kept both components'
  framing and merged the two bill panels into one). Four conflicts, all resolved by taking the peer's version as the base.
- **The drift script got stricter and found that strictness was warranted.** Before: any row without a Price List name was
  skipped silently. After: GPT-6 Astra (Marketplace list, `OpenAI …` servicename, single 30-minute TTL), Nova Micro and
  gpt-oss (first-party `AmazonBedrock` list, "1K tokens" units) are compared to the cent — all three match; the five OpenAI
  rows AWS does not publish are allow-listed with the model-card date; anything else absent now fails.
- **Cache churn is per project, never per session**, because Bedrock's invocation log carries no session id. The help entry
  says so rather than implying a finer grain.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/projects.ts` | fast rows: `cacheReadTokens`, `cacheWriteTokens`, `cacheWriteShare` (3 dp; null without cache traffic) |
| `backend/lambdas/api/overview-calc.ts` + test | movers: same three fields, current window only; tests 0.75 / 0.1 / null and prior-window exclusion |
| `backend/lambdas/api/pricing-completeness.test.ts` | `CACHE_WRITE_FREE` = nova-micro, gpt-oss-120b, gpt-oss-20b (published reasons); gpt-5 gone with the row |
| `backend/scripts/check-rate-card.ts` | first-party reader; `MODEL_NAMES['gpt-6-astra']`; OpenAI servicenames; `cache_write_tokens_30m` → both TTL columns; `NOT_IN_LIST_OK`; exit 1 on unexplained absence (cache kinds the list does not sell tolerated when the card says 0) |
| `frontend/src/pages/CostsPage.tsx` | one "Account bill vs all tenants' logged estimate" panel (billedZero / overEstimated badges, Mantle columns, logged-share total, billedFrom→billedTo footer); "unpriced" badge in Est. cost |
| `frontend/src/pages/OverviewPage.tsx` | Cache churn column on "What changed"; Spend tile: "N unpriced models" chip, excluded-token suffix, unlogged-total suffix |
| `frontend/src/pages/ProjectsPage.tsx` | Cache churn column; Full-view caption waits for the Athena scan |
| `frontend/src/pages/DoraPage.tsx` | `plural()` on day / merge / PR / repository / project counts |
| `frontend/src/main.tsx` | `*` → `NotFoundPage` in the shell ("No page at <path>"), no redirect |
| `frontend/src/lib/help-content.ts` | `cost.unpriced`, `cost.mantle` (rewritten), `project.cache-churn` |
| `frontend/src/api/client.ts`, `styles.css` | movers churn fields; `.notice` styles |
| `docs/incidents/2026-10-cache-write-omission.md` | "$0 bill" root cause corrected to the service-name filter (#73's finding) |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` (projects-sql, overview-calc, pricing-completeness, rollup-fields) | 42 / 42 |
| Backend `tsc --noEmit` | PASS |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 13 source files, all named |
| `check-rate-card.ts` (live, 2026-10-23, post-#74 card) | **OK** — 14 rows compared incl. GPT-6 Astra $10/$50/$1/$12.50, gpt-oss-120b $0.15/$0.60, gpt-oss-20b $0.07/$0.30, Nova Micro $0.035/$0.14/$0.00875; 5 OpenAI rows + 2 Mythos rows allow-listed with sources |

## Local render (2026-10-23, owner login, `vite preview` of this branch against the dev API, 1440×1000)
| Check | 30 d | 90 d |
|---|---|---|
| `/costs` — exactly one bill panel ("Account bill vs all tenants' logged estimate"); old "Not logged: bedrock-mantle" panel gone | 1 / 0 | 1 / 0 |
| `/costs` — bill panel: opus-5-5 $5,331.48 billed / $4,230.34 logged / **$1,101.14 not logged** · 5,816 Mantle inferences · 1.58B tokens; "estimate above bill" on fable-5 and haiku; total "89% of the bill is logged" $10,035.93 / $8,945.82 / $1,102.70; footer "Bill 2026-09-24 → 2026-10-22 (29 billed days…)" | rendered | rendered |
| `/costs` — "unpriced" badge in Est. cost + `UnpricedNote` | none — correct: `/v1/overview?window=30` has no unpriced ids | **5 badges** (DeepSeek R1, Kimi K2 Thinking, Kimi K2.5, Llama3 8b, Ministral 3b) + note "5 models in last 90 days have no row on the rate card…" |
| `/` Spend tile — chip + suffixes | "+ $1,102.70 billed but not logged (bedrock-mantle; Cost Explorer; not included)" | chip **"5 unpriced models"** · "excludes 568 tokens on 5 unpriced models · + $1,352.89 billed but not logged" |
| `/` and `/projects` — "Cache churn" column present, every cell "—" | yes — by design until the Api deploy ships the new fields | yes |
| `/dora` — count strings | "no merges to main in 30 days", "53 merged PRs" — no "1 days"/"1 PRs" anywhere | — |
| `/does-not-exist` — stays at its URL, header "Page not found", body "No page at /does-not-exist", "Back to Overview" | yes | — |
| Console errors across all pages | **0** | 0 |

Screenshots were reviewed by eye for the two Costs panels and the Overview tiles; no label collisions or overflow at 1440 px.

## Live (after push — qa)
_To be filled._

## After merge — owner action
`Tums-dev-Api` deploy (OverviewFn + ProjectsFn code) so the Cache churn columns fill; until then they read "—" by design.
