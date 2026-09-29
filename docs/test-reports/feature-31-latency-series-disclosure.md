# Feature 31 — /latency: fleet and per-model figures are separate series (disclosure)

- **Chain:** `intent/latency-series-disclosure/` · **Branch:** `fix/latency-series-disclosure` off `main@533abee` (post-#63) · **PR:** #64
- **Origin:** qa F-PR63-001 (LOW) — by-model rows 4,336 vs fleet tile 4,187 on the same 7-day window, suspected double count of profile-routed calls.
- **Date:** 2026-09-28
- **Verdict:** PASS. Copy only; the claim it makes was checked at the source.

## Evidence
CloudWatch `AWS/Bedrock` `InvocationLatency` `SampleCount`, 2026-09-21 → 09-28: fleet (no dimension) **4,240**;
Σ over the 9 `ModelId` series **4,240** (profile `c5xf7omvk87g` 556 included). Equal — no double count, as on
2026-09-18 (19,194 == 19,194). qa's gap was the two series being published separately: per-model can lead the
aggregate for minutes after a burst. The page did not say so; now it does, so under the #62 rule the difference
is disclosed and is not a finding.

## Also verified on #63's qa run
The `/projects` Full-vs-Fast disclosure was **not** filed — the #62 rule works on its first live run.

## Gates
Frontend `tsc` + `vite build` PASS; `sdlc_ci_gate.py` see CI. qa: this PR's run must not file the by-model-vs-fleet
difference — result recorded below.

## qa result on this PR — a hollow green, recorded as such
Both runs on the final commit returned `overall: PASS`, 0 findings, in ~2 minutes with a 358-character transcript:
Bedrock answered the harness with `ServiceUnavailableException` on both the exploration call and the structured
retry, so **nothing was explored**. `qa_agent.py`'s `normalize_report` rewrote the `UNKNOWN` fallback to `PASS` on an
empty findings list — the defect the next chain (`qa-empty-run-honesty`) fixes. **The disclosure this PR adds has
therefore not been verified by a real qa run.** It will be, on the next frontend PR after the fix lands.
An earlier overlapping run (commit `062d162`) was terminated mid-exploration and reported FAIL honestly — its two
Overview MEDIUMs (Budget-tile disclosure plausibility; freshness caption vs 2 h-old rollups) are not this PR's and
are queued for triage once a complete run exists.
