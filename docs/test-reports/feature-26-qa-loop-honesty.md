# Feature 26 — QA loop honesty (the check colour matches the report; the bot stays inside the plan)

- **Chain:** `intent/qa-loop-honesty/` · **Branch:** `fix/qa-loop-honesty` off `main@2a9630c` (post-#54) · **PR:** TBD
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

## Live (filled after the first CI run of this PR)
- `ui-qa-agent` check colour vs the posted report's `overall`: _pending_
- Bug-Fix agent refusals (files outside `intent/qa-loop-honesty/plan.md`): _pending_
