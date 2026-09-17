# Plan: AI-coding ROI page (feature-14)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 95b32dc2b8a697a2aef06860d7d35cc3bab73508
- **Status:** accepted

`Accepted-for` is main's tip after PR #39 (project cost attribution) merged — this feature
consumes the per-project spend rollups that PR created, so it could not be cut earlier. Design
approved in plan mode 2026-09-17 against `docs/research-roi-model.md`.

## Files changed

### Pure core (new)
1. `backend/lambdas/api/roi-calc.ts` (new) — the whole model, with no I/O: `computeRoi`,
   `weeklyFromProjday`, `baselineFromHalves`, `referenceBands`, `killFastFlag`,
   `estimateForward`, `ROI_DEFAULTS`, `RCT_BRACKET`
2. `backend/lambdas/api/roi-calc.test.ts` (new) — 17 cases, including the out-of-sample
   kill-fast defect that case 13 exposed
3. `backend/lambdas/ingestion/parse.ts` — `detectRunaways`: pure single-request cost screen,
   priced through the AIP-resolved model, exclusive threshold, request-id de-duplication
4. `backend/lambdas/ingestion/parse-attribution.test.ts` — runaway threshold/pricing cases
5. `backend/lambdas/shared/project-registry.ts` — `ProjectRoiConfig` on a registry project,
   pure `validateRoiConfig`, and the org-defaults item (`getRoiDefaults` / `putRoiDefaults`)
6. `backend/lambdas/shared/project-registry.test.ts` — `validateRoiConfig` range/shape cases

### Runtime
7. `backend/lambdas/api/roi.ts` (new) — `GET /v1/roi/projects`, `GET /v1/roi/estimate`;
   assumption precedence project ▷ org ▷ code; the `methodology` block including refusals
8. `backend/lambdas/api/project-registry.ts` — `GET/PUT /v1/projects/registry/defaults`
   (PUT admin-only) and `roi` exposed on the project view
9. `backend/lambdas/ingestion/aggregator.ts` — runaway detection per batch, written to the
   Anomalies feed with the reader's key shape and a deterministic (idempotent) sort key

### Infra
10. `infra/lib/stacks/api-stack.ts` — `RoiFn` (512MB/20s, **read-only** grants on tenants,
    aggregates and dora) plus the `v1/roi/{projects,estimate}` and `registry/defaults` routes
11. `infra/lib/stacks/etl-stack.ts` — aggregator `ANOMALIES_TABLE` + `RUNAWAY_REQUEST_USD` env
    and the anomalies write grant
12. `infra/lib/config/types.ts` — `projects.runawayRequestUsd`

### Frontend
13. `frontend/src/pages/RoiPage.tsx` (new) — methodology banner, break-even strip, component
    waterfalls with signed bars and assumptions drawer, portfolio scatter, forward estimator,
    observational-cohort note
14. `frontend/src/api/client.ts` — ROI types and the `roiProjects` / `roiEstimate` /
    registry-defaults calls
15. `frontend/src/lib/format.ts` — `fmtSignedUsd`, `fmtUsdK`
16. `frontend/src/main.tsx` — `/roi` route and page metadata
17. `frontend/src/components/Layout.tsx` — the ROI nav entry

Non-source riders: `.gitignore` (ignore the real per-clone `.claude/settings.json`, whose
filled inference-profile ARNs embed the account id — the leak class flagged during feature-13),
`.sdlc/active` (pointer handover), `intent/project-cost-attribution/*` (marked shipped),
`intent/roi-page/*` (this chain), docs (`docs/ROI_METHODOLOGY.md`,
`docs/research-roi-model.md`, `CHANGELOG.md`, `README.md`, `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `docs/test-reports/README.md`,
`docs/test-reports/feature-14-roi-page.md`).

## Verification

- Gates, all green on this tree before any push: backend jest + tsc, frontend build,
  `cdk synth` with env=ci.
- Live (dev): deploy Etl + Api; `PUT /v1/projects/registry/defaults` sets org assumptions;
  a real `roi` object on the token-monitoring project; the page renders the honest result with
  signed stability and visible refusals; the estimator's P50 matches a hand computation; a
  synthetic runaway (threshold temporarily lowered, one log object re-processed) appears on the
  Anomalies page and the threshold is then restored.
- Recorded in `docs/test-reports/feature-14-roi-page.md`, including the pre-existing
  anomaly-response key-shape mismatch this feature deliberately did not fix.

## Risks

Per-project fan-out matches the existing DoraFn profile (512MB/20s). Reference bands need ≥4
weeks of history and the page shows an insufficient-history state rather than a fabricated
band. README and ROADMAP counts are rechecked against merged main rather than the stale
pre-merge numbers.
