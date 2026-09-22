# Plan: QA loop honesty

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** b4398241ef76f17aa85f2d70436a82bfd347988c
- **Status:** accepted

`Accepted-for` is bound to `b4398241` — the tip of `main` after #55 (feature-25) merged, which is this
branch's merge base once main is merged in. The work was first staged against `8693ff42` (post-#53),
re-staged on `2a9630ca` when #54 merged mid-work, and re-bound again when #55 merged while this PR was
in review. Each re-stage was verified by diffing main-vs-main for the files this branch edits; the
third one found one real overlap — `ProjectsPage.tsx`, where #55's bot round bound "Projects tracked"
to the rollup count in Full view. That binding is kept; this branch's per-tile source labels sit on
top of it and say why the header count differs from the Athena row count below. Three rebindings,
all recorded rather than rewritten away.

## Files changed

### CI agents
1. `ci-agent/qa_agent.py` — write `overall` to `$GITHUB_OUTPUT` beside the existing four flags, with
   `UNKNOWN` as the fallback. The comment at the write site states why it is needed (the step runs
   under `continue-on-error`, so a later step is the only thing that can carry the verdict). The exit
   code is unchanged.
2. `ci-agent/bugfix_agent.py` — three new module-level functions and the gate that uses them:
   - `active_plan(repo_root)` → `(plan_text | None, label)`, failing closed on a missing/empty
     `.sdlc/active` or a chain with no `plan.md`.
   - `plan_covers(plan_text, rel)` → the substring mirror of `sdlc_ci_gate.plan_covers`, with a
     docstring stating that behavioural identity is the requirement.
   - `recurrence_note(finding, report)` → the repeat-report sentence, or `''`.
   - `--patched-list` (default `bugfix-patched.txt`); `patched` accumulated beside `applied`; the
     no-findings early return writes an empty list so the workflow can read it unconditionally.
   - The in-loop gate immediately after `rel` is computed: refuse, summarise, `⛔` to stderr,
     `continue` — no harness invoke for a file the plan does not name.
   - The out-file header gains a `Scope:` line naming the chain whose plan bounds the edit.
   - The `return 0` rationale is extended: redness now belongs to the new terminal workflow step.

### Workflow (not a gate-checked source type, listed for completeness)
3. `.github/workflows/ui-qa-agent.yml` — job-level `QA_RED_ON: FAIL` with the two options documented
   inline; `id: fix` on the Bug-Fix step so its `pushed` output is addressable; the staging block
   replaced with the exact-path `xargs -0 git add --` over `bugfix-patched.txt` plus
   `pushed=true|false`; the new terminal step **"Fail check if the QA report is not clean"**,
   placed after the stall and fuse steps and before "Converged - clear loop state", keyed on
   `steps.fix.outputs.pushed != 'true'` with `overall`/`blocking`/`findings` routed through `env:`;
   and two steps added after the first live run: the staging loop fails loudly on a listed path that
   is not on disk (a `2>/dev/null || true` there made a broken patch read as "no applicable source
   patch"), and a **"Redact QA diagnostics"** + **"Upload QA diagnostics"** pair keeps
   `qa-report.json` / `qa-output.txt` / `bugfix-summary.md` / `bugfix-patched.txt` as a 14-day
   artifact — after `.github/scripts/redact.js`, withholding any file that still matches a secret
   pattern, because artifacts are not log-masked and the repo is public.

### Frontend
4. `frontend/src/pages/ProjectsPage.tsx` — `rowSource` and a local `srcChip` helper; a source chip and
   a provenance `foot` on "Projects tracked" and "Total tokens"; a chip on "Total est. cost" (its foot
   already disclosed the gap). The comment above them records why per-tile labelling was chosen over
   binding the header to one source. No number and no query changes.
5. `frontend/src/pages/LatencyPage.tsx` — one clause added to each of the two fleet KPI feet, stating
   that the first-byte sample set is contained in the end-to-end one and that the two do not add up.
   Copy only.

### Docs and chain riders
6. `AGENTS.md` — a new section, "The CI QA loop's rules", stating all three rules with the specific
   failure each prevents, so the next agent in this repo does not re-derive them.
7. `CHANGELOG.md` — one entry.
8. `docs/test-reports/feature-26-qa-loop-honesty.md` + its row in `docs/test-reports/README.md`.
9. `intent/qa-loop-honesty/{intent,spec,plan}.md` (this chain); `.sdlc/active` → `qa-loop-honesty`;
   `intent/settings-and-format/*` → `shipped` (landed as #55; `roi-cost-tables` was already flipped by #55).

## Commit order

1. `docs(sdlc)`: this chain + `.sdlc/active` handover + the previous chain → shipped.
2. `fix(ci)`: `ci-agent/qa_agent.py`, `ci-agent/bugfix_agent.py`,
   `.github/workflows/ui-qa-agent.yml`.
3. `fix(frontend)`: `frontend/src/pages/ProjectsPage.tsx`, `frontend/src/pages/LatencyPage.tsx`.
4. `docs`: `AGENTS.md`, `CHANGELOG.md`, the test report + index row. Open the PR.

No API or infra change, so there is nothing to deploy before pushing — the usual
"deploy the API before the frontend commit lands" ordering does not apply here.

## Verification

- **Gates:** backend `jest` + `tsc --noEmit` (untouched by this branch, but CI runs them);
  frontend `tsc --noEmit` + `vite build`; `cdk synth --context env=ci`; `sdlc_ci_gate.py` dry run —
  the four gate-checked source files above must all be named in this plan and `Accepted-for` must
  equal `git merge-base github/main HEAD`.
- **`plan_covers` parity:** exercised directly — a path the plan names returns `True`, one it does not
  returns `False`, a Windows-separator path normalises, and `active_plan` on a directory with no
  `.sdlc/active` returns `(None, 'no .sdlc/active')` so the caller refuses everything.
- **`recurrence_note`:** fires on evidence citing earlier `F-…` ids, fires on a reconciliation entry
  marked `STILL_FAILING`, and returns `''` on a first report.
- **The new workflow step is verified by its first real run on this PR**, which is itself the test:
  this branch touches `frontend/**`, so `ui-qa-agent` runs, and the check's colour must match the
  posted report's `overall`. Whichever way it lands is evidence — recorded in the test report.
- **Leak-scan every push:** no 12-digit account ids, no key material, no customer names.

## Risks

- **Every PR now goes red on LOW copy nits.** That is the `QA_RED_ON: FAIL` default and it is the
  owner's decision, but it is a real change in day-to-day friction: a report with one LOW wording
  finding and nothing else will block a merge until it is fixed or the knob is switched to
  `BLOCKING`. The knob exists precisely so this is reversible in one word.
- **This branch will make itself red if the QA agent finds anything at all** — including findings on
  pages it does not touch, which is how #53 ended up with a FAIL report about already-merged code.
  The triage belongs in the PR, not in a severity downgrade.
- **The bot is now strictly less able to fix things.** A finding outside the active plan gets a
  refusal instead of a patch. That is the intended trade (a refusal is honest; a rejected patch is
  not), and §4's recurrence note is what keeps the refusals from accumulating silently.
