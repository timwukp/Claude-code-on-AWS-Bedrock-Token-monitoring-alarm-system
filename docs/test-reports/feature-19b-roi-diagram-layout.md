# Feature 19b — ROI model diagram layout (footnotes no longer under the result box)

- **Chain:** `intent/roi-diagram-layout/` · **Branch:** `fix/roi-diagram-layout` off `main@16da459` (post-#58) · **PR:** #59
- **Origin:** owner's screenshot of the live `/roi` page, 2026-09-24: the ROI result box overlapping the
  "Adoption dip (J-curve …)" footnote, which was also clipped at the right edge.
- **Date:** 2026-09-24
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **A layout bug, not a data bug.** The result box (x 660–940, y 312–408) and the provenance lines (y 404–436,
  full width) were drawn over each other in the feature-19 SVG; the first provenance sentence was also wider than
  the 960-unit viewBox. Nothing the diagram says has changed.
- **Fixed by moving, not shrinking.** Provenance starts at y 430 (below the box), the long sentence wraps to two
  lines, the viewBox grows to 506. Legend swatches stay where they were — they never overlapped.

## Scope
| File | Change |
|---|---|
| `frontend/src/components/RoiModelDiagram.tsx` | provenance y 404/420/436 → 430/444/462/478 (sentence wrapped); refusal note y 452 → 494; viewBox 470 → 506 |
| `frontend/src/lib/time-range.ts` | **qa F-PR59-001 (HIGH, pre-existing, found on this PR's first run):** Usage 30 d showed 20.61M / 13.67M input/output vs Cost 30 d 13.17M / 10.43M — the 7.44M gap is exactly the 08-25 bucket. The shared hook started at `now − 30×24h` (mid-day 08-25) so Usage's daily buckets covered 31 days; `/v1/overview` covers 30 calendar days from UTC midnight (08-26 → 09-24). `windowBounds` now starts at UTC midnight of `today − (N−1)`. Added to this plan so the fix ships with the PR that surfaced it |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 1 source file, named in the plan |

## Local authenticated render (build served on :4177, live dev API, owner's session, 1600 px wide)
| Check | Result |
|---|---|
| Result box vs footnotes | measured with `getBoundingClientRect`: none of the four provenance `<text>` nodes intersects the result `<rect>` (box bottom 772 px; first footnote top 787 px) |
| Right-edge overflow | widest line (Model skeleton) ends at 1431 px; SVG right edge 1471 px — inside |
| Adoption-dip sentence | two lines, both fully visible |
| Screenshot | `/tmp/tums-audit/local/f29-roi-diagram.png` reviewed — legend left, result box right, footnotes below |
| Console errors | 0 |

## qa round 1 (`ca35fa3`) — F-PR59-001 and its fix, verified locally before the second push
| Check | Result |
|---|---|
| Root cause | `windowBounds(30)` started at `now − 30×24h` = mid-day 08-25; `/v1/usage` returns whole daily buckets, so Usage counted 31 days (08-25 → 09-24) while `/v1/overview` counted 30 (08-26 → 09-24). Gap 7.44M input = the 08-25 bucket exactly |
| New bounds (`tsx` check, now = 2026-09-24T13:10Z) | 7 → 09-18…09-24 (7 d) · 30 → 08-26…09-24 (30 d) · 90 → 06-27…09-24 · mtd → 09-01…09-24 (24 d) — identical to `overview-calc.windowBounds` |
| 7 d, Usage vs Cost | input **3.62M = 3.62M**, output **4.48M = 4.48M** |
| 30 d, Usage vs Cost | input 13.16M vs 13.17M (row rounding); output 10.28M vs 10.43M — see residual |
| MTD, Usage vs Cost | input 12.87M vs 12.88M; output 9.57M vs 9.72M — same residual |
| Console errors | 0 |

**Residual — a data difference, not a window one.** Day-by-day comparison of `/v1/usage` (hourly rollups) against the
PROJDAY items for the same tenant (DynamoDB query, 08-26 → 09-24, 15 days both sides): 14 days agree to the token;
**2026-09-17 differs — PROJDAY has +12,380 input and +146,311 output tokens more than the hourly rollups.** That is
the whole 30-day and MTD gap. It is an ingestion-side inconsistency for one day, outside this frontend chain.

**Which side is right — settled server-side (qa round 2, `0e8047e`).** Athena over `bedrock_invocation_logs` with the
API's own `tenantFilter`, `COUNT(DISTINCT requestId)`:

| Day | Raw logs (Athena) | Hourly rollups (`/v1/usage`) | PROJDAY (`/v1/overview`, Cost) |
|---|---|---|---|
| 2026-09-16 | 3,402 inv · 2,152,443 in · 1,535,378 out | same | same |
| 2026-09-17 | **7,786 inv · 5,281,890 in · 2,669,497 out** | **identical to raw** | 8,017 inv · 5,294,270 in · 2,815,808 out |

So **Usage is correct and PROJDAY is overstated for 09-17** by +231 invocations / +12,380 input / +146,311 output /
+61.3M cache-read tokens — Opus 5 (+137 inv, +78,224 out), Fable 5 (+58, +67,835), Sonnet 4.6 (+36, +252); every
other model and every other day agree to the token. Both `parse.ts` paths de-duplicate by `requestId` *within* a run,
so this is the same objects processed twice across runs — consistent with the feature-13 `backfill-projday.ts`
boundary-day hypothesis raised by the ingestion owner. The excess is spread across up to three project rows per model
(`untagged`, `token-monitoring`, `agentcore-guardrails-design-validation`), so an exact repair must recompute 09-17
per (project, model) and apply the negative deltas — a data write in the ingestion chain's scope, **not done here**.
Effect while unrepaired: Cost / Overview / ROI overstate spend for windows containing 09-17 by ~146k output and ~61M
cache-read tokens (about 1.4% of 30-day output); Usage does not. qa re-files this as F-PR59R2-001 (HIGH) against the
Usage caption's parity claim; the caption is true by definition and false by 231 duplicated records.

**Per-model excess, PROJDAY − raw logs, 09-17 (exact — Σ Δinvocations = +231):**

| Model (raw `modelId` as stored in the PROJDAY items) | Δinput | Δoutput | ΔcacheRead | Δinvocations |
|---|---|---|---|---|
| `…:inference-profile/us.anthropic.claude-opus-5` | +7,502 | +78,224 | +14,483,529 | +137 |
| `…:inference-profile/us.anthropic.claude-fable-5` | +1,026 | +67,835 | +37,386,779 | +58 |
| `…:inference-profile/us.anthropic.claude-sonnet-4-6` | +3,852 | +252 | +9,411,472 | +36 |
| every other model (incl. the two AIP-routed ones re-keyed to `anthropic.claude-fable-5-1` / `…haiku-4-5…`) | 0 | 0 | 0 | 0 |

**Snapshot of the 13 PROJDAY items for 09-17 at the time of this report** (so the repair can address exact keys under
`pk = TENANT#<tenant>#PROJDAY`; the three models above are each split across up to three project rows):

| sk (`2026-09-17#<projectId>#<modelId>`, account id redacted) | inputTokens | outputTokens | cacheReadTokens | invocations |
|---|---|---|---|---|
| `2026-09-17#untagged#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-opus-5` | 36,464 | 1,160,087 | 111,087,952 | 1,755 |
| `2026-09-17#untagged#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-fable-5` | 13,187 | 524,915 | 88,620,090 | 757 |
| `2026-09-17#token-monitoring#anthropic.claude-fable-5-1` | 3,111 | 296,644 | 85,346,944 | 1,270 |
| `2026-09-17#token-monitoring#anthropic.claude-haiku-4-5-20251001-v1:0` | 4,918,150 | 232,411 | 0 | 1,013 |
| `2026-09-17#agentcore-guardrails-design-validation#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-fable-5` | 17,954 | 201,215 | 47,220,260 | 115 |
| `2026-09-17#token-monitoring#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-opus-5` | 18,880 | 183,839 | 34,007,001 | 322 |
| `2026-09-17#token-monitoring#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-fable-5` | 3,060 | 115,896 | 63,184,235 | 100 |
| `2026-09-17#untagged#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-4-6` | 265,475 | 62,668 | 191,715,811 | 2,485 |
| `2026-09-17#agentcore-guardrails-design-validation#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-opus-5` | 2,373 | 30,020 | 7,790,561 | 68 |
| `2026-09-17#agentcore-guardrails-design-validation#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-4-6` | 6,865 | 7,596 | 14,946,358 | 65 |
| `2026-09-17#token-monitoring#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-4-6` | 6,848 | 448 | 17,021,587 | 64 |
| `2026-09-17#untagged#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0` | 1,507 | 43 | 0 | 2 |
| `2026-09-17#agentcore-guardrails-design-validation#arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0` | 396 | 26 | 0 | 1 |
| **Σ PROJDAY 09-17** | **5,294,270** | **2,815,808** | **660,940,799** | **8,017** |

**Why no per-row Δ here.** A first per-row pass using tiers 1/2/4 of the aggregator's attribution (AIP tag ▷
`requestMetadata.project_id` ▷ untagged) failed the sanity check — Σ Δinvocations came to −504, not +231 — because it
omitted tier 3 (registry identity hints: `loadAttributionMaps` in `shared/project-registry.ts`), so calls from hinted
principals land in `untagged` on the Athena side and under their project in PROJDAY. Per-row deltas therefore require
the ingestion chain's own attribution code; they are not derivable from this report's queries and are left to the
repair chain, whose sanity rule is: every row Δ ≥ 0 and Σ Δinvocations = +231.


## Live (after push — qa)
_To be filled from the qa report on the PR._
