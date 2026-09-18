# Plan: live ROI model diagram (feature-19)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** e4895b0a30209a5474630e9321d764c5b84d84df
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #43 (feature-16), the merge base at PR time. This chain was
first accepted against `37ae499` (post-#44) and **re-accepted** against the post-#43 tip after a 3-way
merge: `RoiPage.tsx` carries #43's article fix plus this chain's insertion; `.sdlc/active` hands over
from `dora-copy-density`. Merge queue agreed with the other active session: this chain (19) →
`ux-foundation` (20) → their `latency-observability` (18).

## Files changed

### Frontend
1. `frontend/src/components/RoiModelDiagram.tsx` — new. The inline-SVG model diagram: three input
   columns, Value/Investment totals, ROI result, legend and provenance footer; live values from
   `RoiProjectRow.roi`, refused components faded with their reason; ellipsis clipping; theme tokens
   only. This is the component reviewed live at the 2026-09-18 demo, unchanged apart from the
   wording rows in the spec.
2. `frontend/src/pages/RoiPage.tsx` — import the component; inside the "How to read this page" panel
   add the project `<select>` (bound to the existing `estRef`) and render the diagram; rename the
   waterfall series `J-curve` → `Adoption dip`. No other change.

### Backend
3. `backend/lambdas/api/roi.ts` — `methodology.annualization` string: `J-curve` → `adoption dip —
   DORA's "J-curve"`. Copy only; no logic. Requires a `Tums-dev-Api` deploy for the live check.

Non-source riders: `.sdlc/active` (pointer handover from `athena-attribution-parity`, which #44
shipped), `intent/roi-model-diagram/*` (this chain), `intent/athena-attribution-parity/*` → shipped,
`CHANGELOG.md`, `docs/test-reports/feature-19-roi-model-diagram.md` plus its index row.

## Verification

- Gates: frontend `tsc --noEmit` + `vite build`; backend `jest` + `tsc --noEmit` (no test change — the
  string is not asserted anywhere; confirmed by grep); SDLC gate dry-run with `--require-active`.
- Live (dev): deploy `Tums-dev-Api`, invoke the ROI Lambda directly and assert `methodology.annualization`
  contains `adoption dip` and not `J-curve` outside the parenthetical; deploy the frontend; the
  authenticated Playwright pass loads `/roi`, finds exactly one `svg[role=img]` inside the first panel,
  switches the selector to a second project and asserts the `<title>` text changes, and reports zero
  console/page errors. The served bundle is grepped for `Adoption dip` and for the absence of a bare
  `'J-curve'` string outside the footer gloss.
- Screenshot of `/roi` compared with the demo capture (`/tmp/tums-audit/local/roi-diagram.png`).

## Risks

- **Rebase onto #43.** `RoiPage.tsx` conflicts on one line (#43's article fix vs this chain's import
  and panel insertion) — mechanical.
- **`.sdlc/active` handover.** The pointer moves from `dora-copy-density` to this slug; the gate's
  "pointer handover" note is expected on this PR.
- **The diagram states two model caveats it does not fix** (per-project double counting of a
  people-level cost; first-year applicability on rolling windows). The test report must say they are
  open, so the picture is not read as an endorsement of the arithmetic.
