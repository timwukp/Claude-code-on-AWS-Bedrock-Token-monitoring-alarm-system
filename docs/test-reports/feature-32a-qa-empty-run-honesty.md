# Feature 32a — qa empty-run honesty

- **Chain:** `intent/qa-empty-run-honesty/` · **Branch:** `fix/qa-empty-run-honesty` off `main@24d20ea` (post-#64) · **PR:** #65
- **Origin:** PR #64 qa runs 36428863563 (and re-runs): `overall: PASS`, 0 findings, 358-char transcript, ~2 min — Bedrock `ServiceUnavailableException` on both harness calls.
- **Date:** 2026-09-29
- **Verdict:** PASS on unit checks; the live verification is the next frontend PR's qa run (see below).

## What this report has to say plainly
- **This is a fix to my own qa loop, and the failure was the worst kind: a hollow green.** Feature-26 (#56) specified "UNKNOWN is never rewritten to PASS" and built the workflow's red path for it. `normalize_report` did the opposite on an empty findings list. No run had reached that path until Bedrock failed the harness four times in 14 hours.
- **Three independent causes were untangled on #64, and only one is code in this repo:**
  1. `normalize_report`'s UNKNOWN→PASS rewrite (this chain).
  2. The QA harness execution role (`AgentCore-uitestagent-def-…`, created 05-16) never had any `*CodeInterpreterSession*` permission; the agent's STEP 0 had been working only because the agent improvised with a shell. Inline policy `QaAgentCodeInterpreterAccess` (Start/Invoke/Stop/Get/List on `aws.codeinterpreter.v1`) was added on 2026-09-29 with the owner's authorisation. After it, the agent retrieves credentials and logs in.
  3. Bedrock returns `ServiceUnavailableException: Bedrock is unable to process your request` on the harness's `ConverseStream` calls to `global.anthropic.claude-fable-5` (Strands, max retries 2), while one-token `converse` calls to the same model succeed in ~2 s. The harness is outside this repo; a switch to `us.anthropic.claude-fable-5` / `opus-5` or higher Strands retries is recommended to the owner.
- **Everything here tightens.** A run that cannot prove it explored is red with "verdict withheld", never green.

## Changes
| File | Change |
|---|---|
| `ci-agent/qa_agent.py` | `normalize_report` keeps `UNKNOWN`; exploration-evidence guard (`pages_tested ≥ 1` or transcript ≥ 500 chars) else UNKNOWN + note; `safe_stream` says "NO transcript" when nothing was emitted; `invoke_with_retry` (2 retries, 30/60 s) when the exploration stream produced nothing |
| `.github/workflows/ui-qa-agent.yml` | `concurrency: ui-qa-<pr>`, cancel-in-progress |

## Unit checks (boto3 stubbed)
| Case | Result |
|---|---|
| `normalize_report({"overall":"UNKNOWN","findings":[]})` | stays `UNKNOWN` |
| blank `overall`, no findings (agent produced a report) | `PASS` |
| odd `overall`, with findings | `FAIL` |
| real `PASS` with `pages_tested: 10` | untouched |
| `py_compile`; YAML parse with the concurrency block | PASS |

## Live verification — on this PR (the workflow file is in qa's path filter, so qa ran with this branch's code)
Run 36520605401: attempt 1 *"stream failed before any output … NO transcript"* → retry 30 s; attempt 2 same → retry 60 s;
attempt 3 explored Overview, `/usage`, `/costs`, `/projects`, then Bedrock failed after 426 chars → **partial**, kept;
structured pass → **FAIL, "incomplete test run, 6 pages untested"** (MEDIUM); terminal step **red**. The same Bedrock
behaviour had produced a green check on #64. Verified: no hollow green; the retry absorbs two empty streams; a partial
run is judged on what it saw. Bedrock's rejection of the harness's calls on `global.anthropic.claude-fable-5` persists
(5 runs / 15 h) — outside this repo; model switch recommended to the owner.

Previously planned as: not on this PR. The next frontend PR — the peer's feature-32 —
is the test: if Bedrock is still rejecting the harness, its qa must show **UNKNOWN → red** with "NO transcript" in
the job log; if healthy, a normal PASS/FAIL with a real transcript. Recorded in that PR's report.

## Also recorded from #64's honest run (`062d162`, terminated mid-exploration)
Two Overview MEDIUMs to triage once a complete run exists: Budget tile "$0.00 month-to-date, forecast $2.40 against
$1,000" beside "$1,772.67 spend / 30 d" — the disclosure names a source difference but the reader cannot tell whether
it accounts for the size of the gap; and the footer "rollups refresh every 15 minutes" beside "Data as of … (2 h ago)"
— either the pipeline stalled or the caption is wrong. Neither is this chain's.
