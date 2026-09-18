# Feature 19 — Live ROI model diagram (measured · assumed · refused, per project)

- **Chain:** `intent/roi-model-diagram/` · **Branch:** `feat/roi-model-diagram` off `main@37ae499`
  (post-#44) · **PR:** TBD
- **Origin:** owner request after the 2026-09-18 UX audit — the ROI model has no authoritative
  industry definition, so the page should *show* it, not only describe it. The component was
  hand-deployed to dev for that day's customer demo and reviewed live; this PR is its formal landing.
- **Evidence:** `docs/research-dashboard-ux.md` (finding R4: definitions via progressive disclosure,
  never hover-only; R3: hierarchy and consistency); `docs/ROI_METHODOLOGY.md` (the model the picture
  draws); assumption-mapping review of the "J-curve" line (summarised in the intent).
- **Date:** 2026-09-18
- **Verdict:** PASS on gates; live validation recorded below once this PR's turn in the merge queue
  comes (the dev API currently carries another open chain's Lambda, so a stack deploy from this
  branch is deferred until that chain lands or the owner orders otherwise).

## Two things this report has to say plainly

1. **The picture does not endorse the arithmetic.** It makes two weaknesses of the adoption-dip
   term *visible* — a people-level learning cost charged once per project, and a first-year model
   applied to rolling windows — and leaves them unfixed. Fixing them changes numbers and belongs to
   a chain that edits `roi-calc.ts`.
2. **"J-curve" was a DORA-specific label shown three times and defined nowhere on the page.** It is
   renamed "Adoption dip" (DORA's term kept once in parentheses), and the backend methodology
   string is corrected too, because that copy is API-supplied and would otherwise resurface.

## Scope

| File | Change |
|---|---|
| `frontend/src/components/RoiModelDiagram.tsx` | new — inline SVG, `viewBox 0 0 960 470`, `role="img"` + title/desc, theme tokens with light-theme fallbacks; live values from `RoiProjectRow.roi`; refused components faded with reason; ellipsis clipping |
| `frontend/src/pages/RoiPage.tsx` | import; project `<select>` bound to the existing `estRef`; diagram inside "How to read this page"; waterfall series `J-curve` → `Adoption dip` |
| `backend/lambdas/api/roi.ts` | `methodology.annualization`: `training, J-curve` → `training, adoption dip — DORA's "J-curve"` |

No computed value changes; `roi-calc.ts` and its tests untouched.

## Unit tests and gates

| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` | PASS |
| Frontend `vite build` | PASS |
| Backend `tsc --noEmit` | PASS |
| Backend `jest` | PASS (suite count unchanged — the edited string is not asserted anywhere; confirmed by grep) |
| `sdlc_ci_gate.py --require-active` | PASS — every changed source file named in `intent/roi-model-diagram/plan.md`; `Accepted-for` = merge base |

## Live validation (dev)

_Pending — to be filled at this PR's queue turn:_ deploy `Tums-dev-Api`; direct Lambda invoke asserts
`methodology.annualization` contains `adoption dip`; frontend deploy; authenticated Playwright pass on
`/roi`: one `svg[role=img]` in the first panel, `<title>` changes when the selector changes, zero
console/page errors; served bundle grepped for `Adoption dip` and for no bare `J-curve` outside the
footer gloss.

The identical component was live on dev from 14:10 to the end of the demo (served bundles
`index-CjXdq0CW.js` → `index-B5qe4QiI.js`), verified then with the owner's session on all routes: zero
errors, diagram rendering for every project in the registry.

## Accessibility

- `<svg role="img" aria-labelledby>` with `<title>` naming the project and `<desc>` describing the
  flow; all text is real SVG text (selectable, readable by AT); no information carried by colour
  alone — every box also carries a text tag (`MEASURED` / `ASSUMED` / `DERIVED`) and refused
  components carry the reason in words.
- The project selector is a native `<select>` with `aria-label`.

## Leak scan

`grep -nE '[0-9]{12}|AKIA|arn:aws'` over every file in this PR: no matches.
