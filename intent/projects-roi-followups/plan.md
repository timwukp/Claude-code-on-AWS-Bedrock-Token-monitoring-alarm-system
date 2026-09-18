# Plan: projects / ROI follow-ups

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** de81fb784c1da662ef4ab27721d58d3682946c79
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #48 (feature-21), the merge base at branch time. Small
chain taken while the queue was empty; the other session's `latency-observability` (feature-18) follows
whenever the owner starts it, then `overview-page` (feature-22).

## Files changed
1. `frontend/src/pages/ProjectsPage.tsx` — cent-rounded row sum, `centDrift`, disclosure line in the foot.
2. `frontend/src/components/RoiModelDiagram.tsx` — `<title>` on clipped lines; full refusal sentence under the legend.
3. `backend/lambdas/api/roi-calc.ts` — scoped wording of the no-shipped-output refusal.
4. `backend/lambdas/api/roi-calc.test.ts` — assertion follows the new wording.
5. `backend/lambdas/api/roi.ts` — methodology `refuses` copy names the scope.

Non-source riders: `.sdlc/active` (handover from `global-time-range`), `intent/global-time-range/*` →
shipped (my own predecessor), `intent/projects-roi-followups/*`, `CHANGELOG.md`,
`docs/test-reports/feature-21b-projects-roi-followups.md` plus its index row.

## Verification
- backend `jest` + `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run.
- Local authenticated render: Projects foot shows the cent line when drift > 0; ROI diagram prints the
  full refusal under the legend for a refused project.
- Live: `cdk deploy Tums-dev-Api` **only after feature-18 has landed** (a deploy from a tree without
  `LatencyFn` deletes it); until then the frontend half is validated on dev by qa and the backend wording
  by the unit test.

## Risks
- Wording change to an API string asserted by one test — updated in the same PR.
- The diagram's extra line adds 12 px to a fixed 470-unit viewBox; verified it fits.
