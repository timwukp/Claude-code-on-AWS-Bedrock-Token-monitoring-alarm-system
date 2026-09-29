# Plan: latency series disclosure (feature-31)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 533abeeff0f5d021637f0d10315216d720525915
- **Status:** shipped

`Accepted-for` is bound to `533abeef` — the tip of `main` after #63 (feature-29) merged. One chain at a time by
agreement with the peer, who cuts feature-32 after this lands.

## Files changed
1. `frontend/src/pages/LatencyPage.tsx` — one sentence group in the "By model" panel description. Copy only.
2. `CHANGELOG.md`; `docs/test-reports/feature-31-latency-series-disclosure.md` + index row;
   `intent/latency-series-disclosure/*`; `.sdlc/active` → `latency-series-disclosure`;
   `intent/chart-table-toggle/*` → shipped (landed as #63).

## Verification
Frontend `tsc` + `vite build`; `sdlc_ci_gate.py --require-active`; the PR's own qa run must not file the
by-model-vs-fleet difference (it is now disclosed) — recorded in the report either way. Evidence for the
claim itself: CloudWatch `InvocationLatency` `SampleCount`, last 7 days, fleet 4,240 == Σ per-ModelId 4,240.

## Risks
None to numbers. If qa still files it, the disclosure wording is what needs work, not the data.
