# Plan: DORA copy density (feature-16)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 37ae499f358b38d54caa678ad6448736e4e5cad1
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #44 (Athena attribution parity, feature-17) landed,
which is this branch's merge base once `main` is merged in. Nothing is stacked: #39, #40, #41, #42
and #44 are all merged. The branch was originally cut from `9274c7f` (post-#42) and re-bound here
after #44 merged, because the sdlc gate requires `Accepted-for` to equal the current merge base.

Bookkeeping deliberately left out of this PR: `intent/athena-attribution-parity/*` still reads
`accepted` on `main` even though #44 shipped it. Flipping it here would put files from another
chain into this PR for no functional reason, so feature-18's PR closes it out.

## Files changed

### Metric core
1. `backend/lambdas/dora/dora-calc.ts` — rename the interface `ChangeFailureRate` → `ChangeFailRate`
   and the field `DoraMetrics.changeFailureRate` → `changeFailRate` (DORA's own spelling; its live
   instrument has zero occurrences of "change failure rate"). Export `BANDS_2024_REFERENCE`: the
   `TIERS` thresholds re-expressed in the units a reader compares with, so the disclosure's
   reference table is API-fed rather than duplicating numbers in the page. `MetricKey`, `tierFor`,
   `CFR_BANDS_2024`, `deployFrequencyBand` and `DeploymentFrequency.band` all stay — the disclosure
   still renders them. Rewrite the header block: it currently records that the UI leads with the
   band, which this change makes false.
2. `backend/lambdas/dora/dora-calc.test.ts` — rename references; assert `BANDS_2024_REFERENCE`
   covers every metric that has a tier and that `cfr` is absent from it, so the reference table can
   never grow a change-fail band by accident.

### API surfaces
3. `backend/lambdas/api/dora.ts` — rename the field on the metrics and overview payloads; rewrite
   `DATA_SOURCE.notes` to one claim per note and **delete** the note that says the band leads with
   the rate as supporting arithmetic; add `canonicalSource` and `bandReference`.
4. `backend/lambdas/api/project-calc.ts` — rename the change-fail field read for the Delivery × Cost
   row.
5. `backend/lambdas/api/roi.ts` — rename the change-fail field read into `RoiWindowAggregates.cfrPct`.
   The ROI page's own copy is unaffected; this is the rename reaching its second consumer.

### Frontend
6. `frontend/src/components/Layout.tsx` — `Kpi` gains `chip?: ReactNode`, rendered as a badge beside
   the label; new `Disclosure` component on native `<details>/<summary>`, which is keyboard- and
   touch-accessible without ARIA wiring. A hover-only tooltip is not an acceptable disclosure layer.
7. `frontend/src/styles.css` — one `.disclosure` block (`summary` affordance, body spacing). The
   stylesheet has no `details` rules today.
8. `frontend/src/api/client.ts` — mirror the rename; add `canonicalSource` and `bandReference` to
   `DoraDataSource`.
9. `frontend/src/pages/DoraPage.tsx` — the bulk of the change: delete `TIER_ACCENT`, `TIER_BADGE`,
   `TierBadge` and the `BAND_HEADLINE` short-form map; two grouped KPI panels (Throughput,
   Stability) implementing the tile contract; the AI metric moved out of the DORA grid into the
   cohort panel and renamed to what it counts; the cohort table gains merges and change fail rate
   and loses its `Tier` column; one `Definitions & limitations` disclosure absorbing both long
   caveat paragraphs, the `detail.notes` paragraph and every caveat-carrying tooltip; badges removed
   from both tables.
10. `frontend/src/pages/RoiPage.tsx` — the article fix qa raised on #42 (F-1101): "against **a**
    org-default team size" → `an org-default` / `a code-default`. It is here rather than in #42
    because the gate requires every changed source file to be named in the active plan, and this
    chain is a wording pass.

Non-source riders: `.sdlc/active` (pointer handover), `intent/dora-copy-density/*` (this chain),
`intent/dora-canonical-labels/*` → shipped, `docs/research-dora-card-copy.md` (the evidence this
change implements — small enough to ride with the code, unlike #41), `CHANGELOG.md`, and
`docs/test-reports/feature-16-dora-copy-density.md` plus its index row.

## Verification

- Gates on this tree before any push: backend `jest` + `tsc --noEmit`, frontend `tsc` + `vite build`,
  `cdk synth env=ci` (no infrastructure file changes, but CI runs it), SDLC gate dry-run.
- Live (dev): deploy `Tums-dev-Api` **before** pushing the frontend commit, then confirm on real
  data that `/v1/dora/metrics`, `/overview` and `/projects` return `changeFailRate` and no
  `changeFailureRate`, carry `canonicalSource` and `bandReference`, and no longer carry the
  band-leads note. Fetch the bundle CloudFront actually serves and assert the new labels are present
  and every superseded string is gone.
- Recorded in `docs/test-reports/feature-16-dora-copy-density.md`, including that this reverses the
  band-as-headline decision shipped in #42, and that terseness here is a design judgement rather
  than a research finding.

## Risks

- **It reverses a decision this repository shipped two days ago.** #42 promoted the ordinal band to
  the tile headline; the evidence says DORA's own live instrument has no bands at all. The report
  must state that plainly rather than presenting this as a polish pass.
- **Relocating caveats can silently become deleting them.** The pre-push check is a diff of caveat
  strings between the old and new page, not only a green build: every string leaving a tile face
  must be findable in the disclosure.
- The rename changes the API response shape. Only this product's own frontend consumes it and both
  sides ship in one pull request, but the API is deployed before the frontend commit lands.
