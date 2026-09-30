# Intent: an agent run that explored nothing must not be a green check

- **Slug:** qa-empty-run-honesty
- **Author:** Claude (AI agent)
- **Date:** 2026-09-29
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
On PR #64 the UI QA agent's harness call failed four times over 14 hours with Bedrock
`ServiceUnavailableException` — on the exploration call and on the structured-output retry. Each time
`safe_stream` returned an empty string labelled "partial transcript", `extract_json` found nothing,
`salvage_findings` found nothing, the report fell to the `{"overall": "UNKNOWN", "findings": []}` sentinel —
and `normalize_report` **rewrote `UNKNOWN` to `PASS`** because the findings list was empty. Result: a
2-minute run with a 358-character transcript and a **green** check. Feature-26 (#56) specified that
`UNKNOWN` is never rewritten to PASS and built the workflow's red path for it; the code contradicted the
spec, and no run had exercised the path until then.

Two more things the same runs exposed: two pushes 29 seconds apart ran qa **concurrently** against one
site and one harness (one run was terminated mid-exploration, the other got the empty stream); and the
QA harness's execution role had never held any Code Interpreter permission, so the agent's STEP 0 depended
on it improvising with a shell — fixed on 2026-09-29 by an owner-authorised IAM grant, outside this repo.

A hollow green is the worst outcome this loop can produce: it invites a merge on the strength of a test
that did not happen. Everything here **tightens** what counts as a pass; nothing loosens.

## Non-goals
The severity model; `QA_RED_ON`; the harness's model choice (outside this repo — `global.anthropic.claude-fable-5`
is what Bedrock is rejecting for the harness's large streaming requests; a model switch is the owner's call).
