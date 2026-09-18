# Plan: canonical DORA labels (feature-15)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 06a9f9c4e3a9f43f471de04a264b5428d93c01d0
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #40 (ROI page) and PR #41 (the DORA presentation
research) landed, which is this branch's merge base. The chain was drafted while #40 was still
open and was briefly bound to that branch's tip; because #40 squash-merged, the binding was re-cut
to the merged main tip before this branch was pushed, so no stacked ancestry is involved.

## Files changed

### Metric core
1. `backend/lambdas/dora/dora-calc.ts` — `DeploymentFrequency.band`; `deployFrequencyBand()` with
   DORA's six verbatim buckets and the stated 1.0/day seam rule; `CFR_BANDS_2024`; `TIERS` retyped
   to exclude `cfr` and `tierFor('cfr', …)` returning `Unknown` at every value; header comment
   recording the four canonical-definition caveats (merge-as-proxy, the lead-time end point, why
   `mttr` is not renamed, the uncollected fifth metric)
2. `backend/lambdas/dora/dora-calc.test.ts` — the six buckets, both sides of the 1/day seam, the
   no-sample path, the change-failure tier refusal at every value including 0, and the four
   published values asserted in report order

### API surfaces
3. `backend/lambdas/api/dora.ts` — `band` on the overview row's `df`; `DATA_SOURCE` rewritten to
   carry the disclosures the spec lists; `cfrReference` exported to the client as data
4. `backend/lambdas/api/project-calc.ts` — `band` on the Delivery × Cost row's `df`
5. `backend/lambdas/api/project-calc.test.ts` — asserts the band reaches the project row, since a
   dropped `band` would render every project as "—" while the rate still looked correct

### Frontend
6. `frontend/src/api/client.ts` — `DeployFreqValue` (the band-carrying metric value) applied to the
   metrics, overview and project shapes; `cfrReference` on `DoraDataSource`
7. `frontend/src/pages/DoraPage.tsx` — band-first deployment-frequency tile with "proxy" in its
   label; lead-time and recovery-time labels corrected; the change-failure tile stripped of its
   badge and given the non-monotonic reason; a fifth tile naming deployment rework rate as not
   collected; dated tier badges with DORA's caveat, and "no band" for an empty sample; the caveat
   paragraph, the weekly chart title and both tables reworded

Non-source riders: `.sdlc/active` (pointer handover), `intent/dora-canonical-labels/*` (this
chain), `CHANGELOG.md`, and `docs/test-reports/feature-15-dora-canonical-labels.md` plus its index
row. The `roi-page` chain was already marked shipped on main by #40, so it is not touched here.

`docs/research-dora-presentation.md` is the evidence this change implements and is deliberately
**not** in this branch: it shipped in its own docs-only pull request (#41), already merged, so
re-adding it here would duplicate a file main already has.

## Verification

- Gates on this tree before any push: backend jest + `tsc`, frontend `tsc` + build. `cdk synth`
  is unaffected — no infrastructure file changes — but runs in CI regardless.
- Live (dev): after deploying the API, `GET /v1/dora/metrics` carries `band` and the rewritten
  `dataSource` notes, `GET /v1/dora/overview` carries `df.band`, and the rendered page shows the
  band headline, the missing fifth metric, and no badge on change failure rate.
- Recorded in `docs/test-reports/feature-15-dora-canonical-labels.md`.

## Risks

The change is presentational, so the risk is a claim that overshoots the evidence in the other
direction. Every disclosure string is traceable to a numbered section of
`docs/research-dora-presentation.md`, and the two places where the sources are silent — the 1.0/day
seam and the short headline forms of the six bands — are marked in the code as our choice rather
than as DORA's wording.
