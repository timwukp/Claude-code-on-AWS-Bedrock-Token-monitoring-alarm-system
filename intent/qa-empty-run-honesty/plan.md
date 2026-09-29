# Plan: qa empty-run honesty (feature-32a)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 24d20ea8f6b3d764154fe716e447735733a79593
- **Status:** accepted

`Accepted-for` is bound to `24d20ea8` — the tip of `main` after #64 (feature-31) merged. Sequenced before the
peer's feature-32 by agreement: without this, their PR's qa could report a hollow green too.

## Files changed
1. `ci-agent/qa_agent.py` — spec §1–§4: `normalize_report` keeps `UNKNOWN`; exploration-evidence guard after
   normalisation; `safe_stream` message distinguishes no-transcript from partial; `invoke_with_retry` around the
   exploration call.
2. `.github/workflows/ui-qa-agent.yml` — spec §5: per-PR `concurrency` group (not gate-checked; listed).
3. `CHANGELOG.md`; `docs/test-reports/feature-32a-qa-empty-run-honesty.md` + index row; `intent/qa-empty-run-honesty/*`;
   `.sdlc/active` → `qa-empty-run-honesty`; `intent/latency-series-disclosure/*` → shipped (landed as #64).

## Verification
- `python3 -m py_compile`; `normalize_report` exercised with a boto3 stub: UNKNOWN preserved; blank-overall-no-findings
  → PASS; odd-overall-with-findings → FAIL; real PASS untouched. YAML parsed.
- Live: this PR touches neither `frontend/**` nor `backend/lambdas/api/**`, so it does not run qa itself. The first
  frontend PR after it (the peer's feature-32) is the live test: a Bedrock-unavailable run must show **UNKNOWN → red**
  with "NO transcript" in the log, and a healthy run must still PASS. Recorded in that PR's report.
- `sdlc_ci_gate.py --require-active --base-sha 24d20ea8` names the one gate-checked source file.

## Risks
- The evidence guard could withhold a verdict from a genuinely clean run whose agent reported neither
  `pages_tested` nor a transcript. That run would be red with an explicit "verdict withheld" note — the reviewer
  reads the log rather than trusting a green. That is the intended failure direction.
- Retrying a zero-output invoke costs up to ~90 s extra on a Bedrock outage; it never retries a run that produced
  anything.
