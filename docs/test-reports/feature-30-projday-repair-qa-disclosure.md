# Feature 30 — PROJDAY one-day repair (2026-09-17) + qa disclosure rule

- **Chain:** `intent/projday-repair-qa-disclosure/` · **Branch:** `fix/projday-repair-qa-disclosure` off `main@18f976a` (post-#61) · **PR:** #62
- **Origin:** qa F-PR59R2-001 / F-PR61-001 (Usage vs Cost, HIGH — the 09-17 over-count); qa F-PR59R3-002 / F-PR61-002 / F-PR61R2-001 (the disclosed Full-vs-Fast gap filed as a LOW, three times).
- **Date:** 2026-09-28
- **Verdict:** PASS. The repair is already applied and verified on dev; this PR commits the method and the qa rule.

## What this report has to say plainly
- **The repair was run before this PR existed** (2026-09-24, owner-authorised) because the over-count was reddening #61 with a HIGH about data, not code. This PR makes the method reviewable and re-runnable; the marker `SYSTEM#REPAIR#projday / 2026-09-17` makes a second run refuse.
- **Athena could not locate the surplus per row.** It cannot apply the identity-hint tier, so an Athena-only "truth" gave Σ Δ = −504 and every project row wrong (peer's check on #59). The script therefore re-derives the day with the aggregator's *own* code path — the same functions that wrote the items.
- **The naive per-row diff was wrong too, and the script refused it.** Dry run 1: item − truth was negative on `untagged` and positive on project rows — the one-time `HOUR_PROJECT_MAP` had *moved* records, not duplicated them. Accounting for the move gives `surplus(model) = untagged item − (untagged truth − Σ moved project rows)`; those twelve figures matched the independent Athena per-model deltas exactly. The double count sat entirely on the `untagged` rows.
- **The qa rule is a policy change and is labelled as one.** The owner chose it over `QA_RED_ON: BLOCKING` (which would also have silenced the real LOWs this policy caught: `/anomalies` unviewable detections, the `/projects` cache-read disclosure, `/latency` copy).

## Repair evidence (dev, demo tenant, 2026-09-24)
| Step | Result |
|---|---|
| Truth | 3,047 raw objects for 2026/09/17 + 09/18/00h → 7,786 records for the tenant (= Athena `COUNT(DISTINCT requestId)`) → 6 (project, model) rows |
| Dry run 1 (naive per-row) | **REFUSED** — 4 negative rows on `untagged`, 7 positive project rows; Σ Δinv = +231 but misattributed |
| Dry run 2 (treatment-aware) | 2 live rows exact (`token-monitoring` fable-5-1 1,270; haiku 1,013). Surplus: fable-5 +58 inv / +1,026 in / +67,835 out / +37,386,779 cache · opus-5 +137 / +7,502 / +78,224 / +14,483,529 · sonnet-4-6 +36 / +3,852 / +252 / +9,411,472 · haiku 0. **Σ = 231 = expected; 0 problem rows** |
| `--apply` | 3 `untagged` rows corrected by negative ADD → 699 / 1,618 / 2,449 invocations (= truth − moved). Marker `done`. A reserved-word bug (`plan`) in the marker write and missing per-object retry were found on this run and fixed in the committed script |
| After | Hourly `USAGE` vs `PROJDAY`, 2026-08-26 → 09-24: **13,166,204 / 10,458,122 / 24,749 on both sides (Δ 0 / 0 / 0)**. 09-17 alone: 5,281,890 / 2,669,497 / 7,786 = Athena |
| qa on #61, run 2 | F-PR61-001 (Usage vs Cost) **✅ FIXED** by qa's reconciliation |

## Gates
| Gate | Result |
|---|---|
| `python3 -m py_compile ci-agent/qa_agent.py` | PASS |
| standalone `tsc` on `backend/scripts/repair-projday-day.ts` | PASS |
| `sdlc_ci_gate.py --require-active --base-sha 18f976a…` | see CI |
| qa run | none — this PR touches neither `frontend/**` nor `backend/lambdas/api/**` |

## The qa rule's verification
Lands with the next frontend PR (the peer's feature-29): its qa run must **not** file the `/projects` Full-vs-Fast disclosure, and must still file real findings. Recorded there.
