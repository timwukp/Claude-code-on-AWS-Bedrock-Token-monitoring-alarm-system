# Spec: projects / ROI follow-ups

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

1. **`ProjectsPage.tsx`** — `rowsCost` = Σ(round(row.estimatedUsd, 2)) rounded to the cent;
   `centDrift` = |apiTotalUsd − rowsCost| to the cent. When the existing >$0.50 residual branch does not
   apply and `centDrift > 0`, the "Total est. cost" foot reads: `per-model rates — same rate card as the
   Cost page · rows are shown to the cent, so their sum ($X) can differ from this total by a few cents ·
   rollups as of HH:MM UTC`. Header value unchanged (still the rollup).
2. **`roi-calc.ts`** — the no-shipped-output refusal becomes: `ROI not computed: nothing shipped in this
   window from this project's linked repositories (no merged PRs, no deployments) — other repositories may
   have shipped, but only this project's own delivery counts here — so no delivery evidence supports a
   return; only the measured spend and the break-even threshold below are shown.` `roi-calc.test.ts` (6b)
   asserts the new prefix. `roi.ts` `methodology.refuses` gets the same scope wording.
3. **`RoiModelDiagram.tsx`** — the clipped refusal and break-even lines carry `<title>` with the full
   text; when ROI is refused, a full-width line under the legend prints `Why ROI is not computed here:
   <reason>` (capped at 150 characters with an ellipsis, which no current reason reaches).

## Out of scope
F-1703, F-1704, `format.ts`, Latency, any file in another open chain.
