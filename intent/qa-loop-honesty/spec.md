# Spec: QA loop honesty

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `qa_agent.py` publishes its verdict

`$GITHUB_OUTPUT` gains `overall=<PASS|FAIL|UNKNOWN>` alongside the existing `blocking`, `progress`,
`fixed` and `findings`. `UNKNOWN` is emitted when the report has no verdict — the agent never
produced a parseable report — and is never silently rewritten to PASS. The process's own exit code is
unchanged (`1` when blocking findings remain): it is still correct, it is just no longer the only
carrier of the verdict.

### 2. The job's colour follows the report

A terminal workflow step, **"Fail check if the QA report is not clean"**, runs only when the fix step
pushed nothing (`steps.fix.outputs.pushed != 'true'`) — that is, only on a run that *ends* the loop.
When a fix was pushed, the re-triggered run renders the verdict instead, so judging the current run
would redden a PR that is mid-convergence.

| `overall` | `QA_RED_ON: FAIL` (default) | `QA_RED_ON: BLOCKING` |
|---|---|---|
| `PASS` | green | green |
| `FAIL`, blocking findings | **red** | **red** |
| `FAIL`, only LOW findings | **red** | green + a `::warning::` naming the count |
| empty or `UNKNOWN` | **red** | **red** |

`QA_RED_ON` is a job-level `env` knob; switching it is a one-word change and affects nothing else.
An empty or `UNKNOWN` verdict is red under both settings: "the agent produced no report" must not
read as "the agent found nothing". Every value the step branches on is routed through `env:`, the
file's existing convention against expression injection.

The pre-existing red paths keep precedence and their own messages: the stall detector (two
consecutive zero-progress rounds) and the absolute round fuse both still `exit 1`, and when either
fires this step does not run.

### 3. The Bug-Fix agent stays inside the active plan

`active_plan(repo_root)` reads the slug from `.sdlc/active` and returns the text of
`intent/<slug>/plan.md` plus a label for it. It returns `(None, <reason>)` — and the caller then
refuses to patch **anything** — when `.sdlc/active` is missing, empty, or names a chain with no
`plan.md`. Failing closed is the point: with no plan, the gate rejects every source change, so any
patch would redden `sdlc-gate`.

`plan_covers(plan_text, rel)` is a plain substring test after normalising `\` to `/`, **behaviourally
identical to `sdlc_ci_gate.plan_covers`**. This is a requirement, not an implementation detail:
stricter and the bot refuses patches the gate would accept; looser and it pushes patches the gate
rejects, which is the failure being fixed.

For each blocking finding, after the source file is located and before the harness is invoked:

- **covered** → unchanged behaviour; on a successful apply the path is appended to the patched list.
- **not covered** → no invoke, no patch. The summary gets
  `- **<id>** — \`<rel>\` is not named in the active plan (\`<chain>\`), so it was **not patched**.`
  and stderr gets one `⛔` line. The run continues to the next finding.

The refusal is a result, not an error: `main()` still returns 0, so the summary is written, the PR
comment still posts, and redness belongs to the step in §2.

### 4. Recurrence is named, not silently repeated

`recurrence_note(finding, report)` returns a sentence to append to a refusal summary when the finding
is a repeat — either the reconciliation block marks it `STILL_FAILING`, or its evidence text cites
other `F-…` ids (findings name their own ancestry). The sentence states that the finding needs its own
intent chain naming the file, and why: waiting for a plan that happens to cover it is what let it
recur. Returns `''` when there is no evidence of recurrence, so a first report reads normally.

### 5. The commit step stages exactly what was patched

`bugfix_agent.py --patched-list <path>` writes one repo-relative path per line for each file it
actually patched, and writes an empty file when there was nothing to patch (the workflow reads it
unconditionally). The workflow stages that list line by line and nothing else, replacing the
directory-scoped `git add -- backend frontend infra`. One list governs both the refusal and the
commit, so the two cannot disagree — and there is deliberately no second, hardcoded path allowlist
in the workflow, which could only diverge from the plan. A listed path that is not on disk fails the
step with a `::error::` rather than being skipped: a silently failed `git add` would read as "no
applicable source patch".

### 5b. Diagnostics survive a red run, redacted

`qa-report.json`, `qa-output.txt`, `bugfix-summary.md` and `bugfix-patched.txt` are uploaded as a
14-day artifact on every run (`if: always()`), **after** passing through `.github/scripts/redact.js`.
Any file that still matches a secret pattern after redaction is withheld with a `::warning::`.
Artifacts are not log-masked and the repository is public; the agents narrate S3 URIs that carry
the account id.

### 6. `/projects` — each header KPI names its source

Each of the three header tiles carries a source chip and a `foot` line saying what was counted:

| Tile | Chip | Foot |
|---|---|---|
| Projects tracked | `Athena` / `rollups`, following the selected source | rows in the table below; in Full, that it counts only tiers ① and ② and that the totals beside it are rollup-sourced and cover every tier |
| Total tokens | `rollups` when the API supplied a total, else the row source | that it spans every project, not just the rows shown, with the rows' own sum quoted and the rollup timestamp |
| Total est. cost | same rule | unchanged (it already disclosed the Athena-vs-rollup gap) |

Labelling each tile is chosen over binding all three to one source, because binding to the rows would
discard the authoritative rollup totals — an earlier deliberate decision (F-401) that keeps them
matching the Cost page — and binding to the rollups would misstate the Athena row count.

### 7. `/latency` — the sample counts are stated as nested, not parallel

The first-byte tile's foot says its count is *a subset of* the end-to-end count, not an additional set
of calls. The end-to-end tile's foot says it covers every call, streaming or not, and that the
first-byte count is contained in it, **so the two never add up**. No number changes.

## Out of scope

- The severity model, the stall threshold and `MAX_FIX_ROUNDS` are untouched.
- `guess_source`'s routing heuristic is untouched (a known residual: LOW findings could mis-route,
  but LOW findings are never sent to the bot).
- Nothing amends a plan automatically.
