# Spec: qa empty-run honesty

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour (`ci-agent/qa_agent.py`)
1. `normalize_report` returns a report whose `overall` is `UNKNOWN` **unchanged**. It derives PASS/FAIL from the
   findings only when the agent produced a report that left `overall` blank or malformed.
2. A `PASS` with zero findings must be **earned**: `pages_tested ≥ 1` **or** a transcript of ≥ 500 characters.
   Otherwise `overall` becomes `UNKNOWN` with `note: "no evidence of exploration; verdict withheld"`, and the
   workflow's existing UNKNOWN branch reddens the check. Either criterion alone suffices, so a clean run that
   reports `pages_tested` passes regardless of transcript length.
3. `safe_stream` distinguishes a stream that failed **before any output** ("NO transcript") from one interrupted
   mid-way ("partial transcript after N chars"). Only the latter is partial evidence.
4. The exploration invoke is retried up to twice (30 s, 60 s backoff) when the stream produced **no output at
   all**; a stream that emitted anything is never retried, because the agent's partial work is real evidence
   and a fresh run would not be comparable.

## Behaviour (`.github/workflows/ui-qa-agent.yml`)
5. `concurrency: group: ui-qa-<pr number>` with `cancel-in-progress: true` — one qa run per PR at a time; a newer
   push cancels the run for the superseded commit, which is also what the check's colour already assumes.

## Out of scope
`QA_RED_ON`; the severity model; the disclosure rule from #62; anything in the harness.
