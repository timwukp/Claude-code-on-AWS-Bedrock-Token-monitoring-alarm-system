# Spec: live ROI model diagram

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. Component `RoiModelDiagram({ row?: RoiProjectRow })`

Inline `<svg viewBox="0 0 960 470" role="img">` with `<title>` ("ROI model for {name}" or "ROI
model") and `<desc>`; all colours via CSS custom properties (`--surface-2`, `--border`, `--text`,
`--text-dim`, `--accent-blue`, `--warning`, `--danger`, `--primary`, `--primary-weak`, `--chart-axis`)
so it follows whichever theme is active.

| Region | Content | Style |
|---|---|---|
| Column 1 — *Inputs · measured by this portal* | AI spend (annualised; sub-line `X in window × factor`) · Delivery (Δ features/yr from `throughput.formulaInputs.deltaFeaturesPerYear`) · Stability | solid boxes, `MEASURED` tag |
| Column 2 — *Inputs · assumptions (editable)* | Team & labour cost · Net time saved % (sub-line: evidence bracket from `uncertainty`) · Revenue conventions · Training & adoption dip (one-time) | dashed boxes, `ASSUMED` tag |
| Column 3 — *Model · DORA first-year AI ROI* | **Value / yr (signed)** with Time saved · Throughput · Stability Δ; **Investment / yr** with AI spend · Training · Adoption dip; **ROI = (Value − Investment) ÷ Investment** with `roiPct`, payback, break-even | component boxes tagged `DERIVED`; totals right-aligned |
| Flow | short arrows column 1 → column 2 at matching rows; column 2 → the Value/Investment boxes; Investment → result | `--chart-axis` hairlines, arrowhead marker |
| Legend + footer | Measured / Assumed / Faded-refused swatches; one-line adoption-dip definition; DORA source + three RCTs; pointer to `docs/ROI_METHODOLOGY.md` | `--text-dim`, 10–10.5 px |

Rules:
- With `row`: every component shows `fmtSignedUsd(valueUsd) / yr`; a component whose refusal string
  is present in `row.roi.refusals` (matched by prefix `throughput` / `stability` / `roi`) renders at
  55 % opacity with `not computed — <reason>` in `--danger`, italic. Without `row`: formulas only.
- Text that would overflow its box is clipped with an ellipsis; nothing overflows or is cropped by
  `overflow: hidden`.
- No `tabular-nums`; the SVG inherits the page font.

### 2. Placement (`RoiPage.tsx`)

Inside the existing "How to read this page" panel, after the paragraph and the refusals list: a row
with the caption "The model, with this project's numbers:", a `<select aria-label="Project shown in
the model diagram">` bound to the existing `estRef` state (so the forward estimator and the diagram
follow the same project), and the caption "solid = measured · dashed = assumed · faded = refused";
then the diagram. Nothing else on the page moves.

### 3. Wording

| Where | Before | After |
|---|---|---|
| Diagram, assumptions column | `Training & J-curve (one-time)` | `Training & adoption dip (one-time)`; sub-line `$X / user · 15% slower for first 3 mo · DORA default` |
| Diagram, investment box | `J-curve` | `Adoption dip`; sub-line `$X · first year` |
| Diagram footer | — | `Adoption dip ("J-curve" in DORA's model): the team is temporarily slower while learning the tool — output dips, then recovers. One-time cost, applies to the first year only; off by default, editable per project.` |
| `RoiPage.tsx` waterfall series | `J-curve` | `Adoption dip` |
| `roi.ts` `methodology.annualization` | `one-time costs (training, J-curve) do not.` | `one-time costs (training, adoption dip — DORA's "J-curve") do not.` |

## Out of scope

Computation changes; the help panel; any other page; the `roi-calc.ts` module and its tests.
