# Spec: ROI model diagram layout fix

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour (`frontend/src/components/RoiModelDiagram.tsx` only)
- `viewBox` 960 × 470 → 960 × 506.
- Legend swatches stay at y 340 / 360 / 380 (they end well left of the result box).
- Provenance moves below the result box (which ends at y 408):
  - y 430 "Adoption dip ("J-curve" in DORA's model): the team is temporarily slower while learning the tool — output dips, then recovers."
  - y 444 "One-time cost, applies to the first year only; off by default, editable per project."
  - y 462 Model skeleton line (unchanged text)
  - y 478 Full method line (unchanged text)
- The optional refusal note ("Why ROI is not computed here: …") moves from y 452 to y 494.
- Acceptance: no `<text>` bounding box intersects the result-box `<rect>`; every text's right edge is inside the
  SVG; 0 console errors.

## Out of scope
Any other file; wording; colours.
