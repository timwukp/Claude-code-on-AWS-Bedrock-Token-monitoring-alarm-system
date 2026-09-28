# Intent: the ROI model diagram's footnotes stop running under its result box

- **Slug:** roi-diagram-layout
- **Author:** Claude (AI agent)
- **Date:** 2026-09-24
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

On the live AI ROI page the owner saw the ROI result box ("ROI = (Value − Investment) ÷ Investment", +107%)
drawn over the diagram's footnotes: the "Adoption dip (J-curve …)" explanation and the model-skeleton line run
beneath it, and the Adoption-dip sentence is also cut off at the right edge of the SVG. The diagram is the page's
one picture of what is measured, assumed and refused (feature-19); a footnote that cannot be read defeats it.

## Evidence

`RoiModelDiagram.tsx`: the result box occupies x 660–940, y 312–408 of a 960 × 470 viewBox; the three provenance
lines are drawn at y 404, 420, 436 from x 20 across the full width, and the first is ~205 characters at 10 px —
wider than the viewBox. Nothing about the data is wrong; the two blocks were simply laid out over each other.

## Desired outcome

Provenance lines start below the result box, the Adoption-dip sentence wraps to two lines, every line ends inside
the viewBox, and the viewBox grows to fit. Same words, same colours, same legend.

## Non-goals

No content change; no change to RoiPage or any other file. Delivered as its own PR because it is visible on the
live site now and must not wait for the feature-29 chain.
