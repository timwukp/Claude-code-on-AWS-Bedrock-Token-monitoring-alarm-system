# Plan: PROJDAY repair script + qa disclosure rule (feature-30)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 18f976a16748c9891f72588a75a98dd4597e1860
- **Status:** accepted

`Accepted-for` is bound to `18f976a1` — the tip of `main` after #61 (feature-28) merged. Cut after it under
the one-chain-at-a-time rule; the peer's feature-29 follows this one by agreement.

## Files changed
1. `backend/scripts/repair-projday-day.ts` — the guarded, treatment-aware one-day repair (spec §1). Already
   run on dev 2026-09-24 with the owner's authorisation; this commits the method.
2. `ci-agent/qa_agent.py` — the disclosure rule in the STEP 4 rules (spec §2). **A change to what qa
   reports, approved by the owner on 2026-09-28 in preference to switching `QA_RED_ON` to `BLOCKING`.**
3. `CHANGELOG.md`; `docs/test-reports/feature-30-projday-repair-qa-disclosure.md` + index row;
   `intent/projday-repair-qa-disclosure/*`; `.sdlc/active` → `projday-repair-qa-disclosure`;
   `intent/latency-per-project/*` → shipped (landed as #61).

## Verification
- `python3 -m py_compile` on the agent; standalone `tsc` on the script (scripts are outside the backend
  tsconfig); `sdlc_ci_gate.py --require-active` names both source files.
- The repair's own evidence is in the report: dry run 1 refused (naive per-row Δ negative on `untagged`),
  dry run 2 passed all three assertions with every figure equal to the independent Athena deltas, apply
  corrected three rows, hourly == PROJDAY Δ 0/0/0 over 30 days afterwards.
- The qa rule is verified by the next frontend PR's qa run: the Full-vs-Fast disclosure must no longer
  be filed while real findings still are. Recorded in that PR's report.
- No qa run on this PR (no `frontend/**` or `backend/lambdas/api/**` change). No deploy.

## Risks
- The rule could be over-applied by the agent to a disclosure that is wrong. The rule text says exactly
  when to file anyway (cause cannot account for size/direction; numbers contradict the sentence) and
  requires quoting the disclosure, so a wrong disclosure produces a *better* finding, not silence.
- The script is one-day, one-tenant by design; it refuses rather than guesses when its arithmetic does
  not close.
