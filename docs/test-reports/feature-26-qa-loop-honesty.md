# Feature 26 — QA loop honesty (the check colour matches the report; the bot stays inside the plan)

- **Chain:** `intent/qa-loop-honesty/` · **Branch:** `fix/qa-loop-honesty` off `main@2a9630c` (post-#54), main `b439824` (post-#55) merged in · **PR:** #56
- **Origin:** owner decision 2026-09-21 on three bot rules, plus qa F-PR53-104 (`/projects` header mixes
  sources) and the `/latency` sample-count wording that let qa invent F-PR53-001.
- **Date:** 2026-09-22
- **Verdict:** PASS on gates and direct exercise of the new helpers. The new workflow step is verified
  by its own first run on this PR, recorded below once it lands.

## What this report has to say plainly
- **PRs #51, #52 and #53 each ended "all checks passed" over a report saying `overall: FAIL`.** The
  cause was not a bug in either agent: `qa_agent.py` exited 1 correctly, but the step runs under
  `continue-on-error: true` (so the fix loop can run), and no later step read the verdict back. The
  case "blocking findings remain · stall counter below 2 · bot pushed nothing" ended green, and
  because nothing was pushed the workflow was never re-triggered to advance the stall counter.
- **`QA_RED_ON: FAIL` means every PR now goes red on LOW findings too.** That is the owner's chosen
  default. It will add friction — one LOW wording nit blocks a merge until fixed — and it is
  reversible with a one-word change to `BLOCKING`.
- **This PR will very likely make itself red.** It touches `frontend/**`, so qa runs, and qa has found
  at least one thing on every PR since #48. That is the point: the red is the report's verdict, and
  the triage of it belongs in the PR comments, not in a severity downgrade.
- **The Bug-Fix agent is now strictly less able to fix things.** A finding whose file the active plan
  does not name gets a refusal and a summary line instead of a patch. Refusing is honest; pushing a
  patch that `sdlc-gate` then rejects (as on #48 and #51) is not.

## Scope
| File | Change |
|---|---|
| `ci-agent/qa_agent.py` | `overall=<PASS\|FAIL\|UNKNOWN>` written to `$GITHUB_OUTPUT`; exit code unchanged |
| `ci-agent/bugfix_agent.py` | `active_plan`, `plan_covers` (mirror of the gate's), `recurrence_note`; `--patched-list`; in-loop refusal for files outside the plan; `Scope:` line in the summary |
| `.github/workflows/ui-qa-agent.yml` | `QA_RED_ON` knob; `id: fix` + `pushed` output; exact-path staging from the patched list; terminal step **"Fail check if the QA report is not clean"** |
| `frontend/src/pages/ProjectsPage.tsx` | source chip + provenance foot on all three header tiles |
| `frontend/src/pages/LatencyPage.tsx` | the two fleet KPI feet state that the first-byte set is contained in the end-to-end set |
| `AGENTS.md` | new section "The CI QA loop's rules" |

No API, infra, query or number change. Nothing to deploy before the push.

## Gates
| Gate | Result |
|---|---|
| Backend `jest` | PASS — 232/232, 22 suites (untouched by this branch; run on the re-staged tree) |
| Backend `tsc --noEmit` | PASS |
| Frontend `tsc --noEmit` / `vite build` | PASS on both stages (`8693ff4` and the re-stage on `2a9630c`) |
| `cdk synth --context env=ci` | PASS — 10 stacks |
| `python3 -m py_compile` on both agents | PASS |
| `sdlc_ci_gate.py --require-active --base-sha 2a9630c…` | **PASSED** — 4 source files, all named in the plan; approval bound to the base this change is built on |

## Direct exercise of the new helpers (`bugfix_agent.py`, boto3 stubbed)
| Case | Result |
|---|---|
| `plan_covers(plan, 'frontend/src/pages/ProjectsPage.tsx')` with the path in the plan | `True` |
| `plan_covers(plan, 'frontend/src/pages/DoraPage.tsx')` with the path absent | `False` |
| Windows-separator path against a `/` plan | `True` (normalised) |
| `active_plan('/tmp')` (no `.sdlc/active`) | `(None, 'no .sdlc/active')` → caller refuses everything |
| `active_plan(<stage>)` | `('latency-profile-labels', text)` — reads the real chain |
| `recurrence_note` with evidence citing `F-PR51-006`, `F-PR52-001` | repeat-report sentence naming both ids |
| `recurrence_note` with a `STILL_FAILING` reconciliation entry | repeat-report sentence |
| `recurrence_note` on a first report | `''` |

## Why per-tile labelling on `/projects`, not one source for the header
Binding all three tiles to the rows would discard the authoritative rollup totals — a deliberate
earlier decision (F-401) that keeps them matching the Cost page. Binding them to the rollups would
misstate the Athena row count, which is what the table below actually shows. Each tile saying where
its number comes from is the only option that changes no number.

## Deploy note
Alongside this branch (not part of it), `Tums-dev-Automation` and `Tums-dev-Etl` were deployed from
pristine `main@8693ff4` with the owner's authorisation, after a `cdk diff` showed code-only changes
(two Lambda `S3Key`s, one ECS task-definition revision; no IAM, no deletions). The #50 anomaly-key
migration dry run was re-run immediately after: `scanned 3 item(s): 3 already readable, 0 to rewrite`.
The deployed `AnomalyResponseFn` bundle was pulled and inspected: it now writes `TENANT#<tenant>` /
`ANOMALY#…` — the reader's key shape.

## Live — the first two CI runs of this PR (2026-09-22, runs 35674532780 and 35674555098)

Two pushes landed a minute apart, so the workflow ran twice against the same dev site. **Every rule
fired as specified, and the colour matched the verdict both times.**

| Rule | Evidence |
|---|---|
| (a) colour = verdict | Both runs: `OVERALL=FAIL`, `BLOCKING=true`, `FINDINGS=3`, fix step `pushed=false` → step "Fail check if the QA report is not clean" exited 1 with the message naming the count. Check **red**. |
| (b) bot stays in the plan | Run 1 summary: `0/2 patched · Scope: only files named in intent/qa-loop-honesty/plan.md` — refused `DoraPage.tsx` and `UsagePage.tsx`, neither in the plan. Run 2: refused `UsagePage.tsx`. No harness invoke for either, no commit pushed, `sdlc-gate` stayed green. |
| (c) recurrence named | Run 1, F-PR56-001 (DORA mismatch): *"This is a repeat report as F-PR51R5-002, F-PR53-102 — it needs its own intent chain naming that file"*. Triggered by the evidence text citing both earlier ids. |

### Triage of the findings themselves (none is a regression from this branch)
| Finding | Verdict |
|---|---|
| HIGH — Overview 10.5/wk vs DORA 6.3/wk (F-PR56-001, run 1) | **Not this branch.** Overview sums per-repo rates across 6 repos; DORA shows one pooled rate. Owned by #55 (`OverviewPage.tsx`, fixed there in `b8ff7e8` per its author). This is the fifth report of the deployment-frequency lineage; rule (c) did its job by saying so. |
| MEDIUM — Overview 2.56B vs Usage 3.10B tokens (F-PR56-002, both runs) | **Not this branch.** Overview excludes prompt-cache writes that Usage includes. Owned by #55 (fixed there in `b8ff7e8`). |
| LOW — `/anomalies` 90-day toggle "one-way" (F-PR56-003, run 1) | **Not this branch, and partly a misread**: the revert control is the global time-range picker in the header (`Layout.tsx:93`, `useTimeRange([7,30,90,'mtd'])`); the in-feed button is a shortcut, not the only control. But this is the **fifth** report of the `/anomalies` window lineage (F-PR51-006 → F-PR52-001 → F-PR53-003 → F-PR53-103 → F-PR56-003) — two controls for one state with the empty state pointing at neither. It needs its own chain; that is exactly rule (c)'s case, and LOW findings never reach the bot so the note cannot fire for it. |
| LOW — `/projects` $9.94 Athena-vs-rollup gap on 0.01M tokens (F-PR56-001, run 2) | **Fair, and fixed here.** `queries.ts:127-130`: the Athena `tokens` column is input + output only, while `est_usd` also prices cache reads. A ~10M cache-read burst since the last rollup is priced but not counted, which is exactly the shape qa saw. The disclosure now says so. `ProjectsPage.tsx` is in this plan. |
| LOW — admin "Settings" nav link appears late (F-PR56-003, run 2) | **Not on main at all.** `/settings` is #55's new page. Its qa run redeployed its frontend to the one shared dev site between my two runs ([[lesson-shared-dev-env-pr-qa-overwrite]]), so run 2 tested #55's bundle. Relayed to #55's author. |

### Follow-up from the first red run (owner-forwarded log analysis)
Two of its three suggestions were taken. **Loud staging:** the `2>/dev/null || true` on the
`git add` was removed; a listed path missing from disk now fails the step with `::error::`. Its
proposed hardcoded `frontend/*|backend/lambdas/api/*` allowlist was **not** taken — the active plan is
the single authority (rule b) and a second list could only disagree with it. **Diagnostics artifact:**
added, but only after `.github/scripts/redact.js` — artifacts are not log-masked and the repo is
public, so a raw `qa-output.txt` would publish the account id. Verified locally with a synthetic
12-digit id and a fake `AKIA…` key: both were redacted in the artifact copy, and `findSecrets` on the
result was empty. Its third suggestion — "fix the remaining blocking finding in this PR" — was
declined: the finding lives in #55's files, is fixed there, and is not in this plan.

### Run 5 — after merging main `b439824` (post-#55) into the branch
| ID | Finding | Status |
|---|---|---|
| F-PR56R3-001 | Overview tokens vs Usage (cache-write classes) | ✅ **FIXED** — #55's definition note is in the bundle |
| F-PR56R3-002 | Overview 10.5/wk vs DORA 6.3/wk | ✅ **FIXED** — both pages now state their scope; values reconcile |
| F-PR56R3-004 | Settings nav link | ✅ **FIXED** — `/settings` exists on main now |
| F-PR56R3-003 → F-PR56R4-001 | `/anomalies`: 2 detections older than 90 days are advertised but unviewable | ❌ STILL_FAILING, **LOW** |

Result: `overall: FAIL` with **one LOW** finding, no blocking findings, bot not invoked (LOW never is), so
the check is **red under `QA_RED_ON: FAIL`** and would be green under `BLOCKING`. This is the precise
consequence the plan's first risk names. The finding is the sixth report of the `/anomalies` window
lineage; `AnomaliesPage.tsx` is not in this plan and the fix (an "all retained" view or a listing of
the out-of-window detections) needs the shared time-range lib, so it is its own chain, not a rider.
**Owner decision (2026-09-22): merge with the red LOW; the `/anomalies` lineage gets its own intent
chain.** `QA_RED_ON` stays `FAIL`. So the first PR to land under the new rule lands with a red `qa`
check whose report says exactly one LOW finding, none of it this PR's — which is the intended reading:
the colour is the report's verdict, and the merge decision is the owner's, made with that verdict
visible instead of hidden behind a green check.

### What this shows about the loop
- The red is **correct** and it is **not actionable by this PR** for four of the five findings. That is the
  trade the owner chose with `QA_RED_ON: FAIL`: the check tells the truth and the triage lives here in
  the report and in the PR comments, instead of a green check over a FAIL report.
- The bot refusing both HIGH/MEDIUM findings is the intended behaviour — both files belong to another
  open PR's plan, and a patch here would have collided with #55.
- Two findings in one run (F-PR56-001 in run 1 vs run 2) were **different findings with the same id**
  — qa numbers findings per run, so ids are not stable across runs. Cross-run identity comes from the
  reconciliation block (prior-report ids), not from the `F-PR56-nnn` label.
