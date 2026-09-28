# Spec: PROJDAY one-day repair script; qa disclosure rule

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## 1. `backend/scripts/repair-projday-day.ts`
Dry run by default; `--apply` required. Re-parses the day's raw S3 objects (plus the next hour, for
boundary spill) through the aggregator's own `parseLogFile → aggregateByProjectDay` with
`loadAttributionMaps` — all four tiers — keeping records whose day bucket and tenant match. Athena is
deliberately not used: it cannot apply the identity-hint tier and misattributes (Σ −504 on #59).
The surplus is located **treatment-aware**: on the boundary day feature-13's one-time `HOUR_PROJECT_MAP`
moved records from `untagged` into project rows, so per model
`surplus = untagged item − (untagged truth − Σ moved project rows)`. Three assertions gate any write:
every live-attributed project row equals truth exactly; every per-model surplus ≥ 0 on all four
counters; Σ surplus invocations == `EXPECT_DELTA_INV` when given. Writes are negative `ADD`s on the
`untagged` rows only, under marker `SYSTEM#REPAIR#projday / <day>` (`attribute_not_exists`); a second
run refuses. Latency attributes are never touched. Fetches retry with backoff and run in a small pool.

## 2. `ci-agent/qa_agent.py` — one rule added to "Rules for the final JSON"
A difference the page itself **discloses and quantifies on screen** is expected behaviour and must not
be filed. It is filed only when the disclosure is wrong — the stated cause cannot account for the
gap's size or direction, or the numbers contradict the sentence — and then the finding must quote the
disclosure and say why it fails. Everything else qa reports is unchanged; `QA_RED_ON` stays `FAIL`.

## Out of scope
Any other qa rule; the severity model; the workflow.
