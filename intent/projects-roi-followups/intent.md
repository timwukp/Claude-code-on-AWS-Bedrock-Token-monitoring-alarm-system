# Intent: close two qa findings the last three PRs kept re-surfacing

- **Slug:** projects-roi-followups
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

The UI QA agent tests the whole dev site on every pull request, so a finding outside a PR's intent
recurs on every PR until a chain owns it. Two such findings have now recurred across #45, #46 and #48
and are small enough to close on their own:

1. **F-1706 — By Project, Fast view.** Per-project USD values sum to `$14,200.97` while the header says
   `$14,200.94`. The header is the authoritative per-model rollup (a deliberate choice, F-401); the rows
   are each rounded to the cent, so a reader adding them up lands a few cents off with nothing on the
   page saying why.
2. **F-1707 — AI ROI.** A project's ROI card says "not computable — nothing shipped in this window (no
   merged PRs…)" while the DORA page shows 27 merges in the same window. Both are right: ROI counts
   merges in **that project's linked repositories**, DORA shows **the one selected repository** — but the
   sentence never says so, and on the model diagram it was clipped mid-sentence with no full-text copy.

## Desired outcome

- The Fast-view footer discloses the cent-rounding residual in one line whenever it is non-zero, and
  the rows' sum is computed the way a reader would (each value rounded to the cent first).
- The refusal sentence names its scope — "from this project's linked repositories … other repositories
  may have shipped" — in the calculator, the API methodology copy and the test that asserts it.
- The diagram never leaves a clipped reason as the only copy: the clipped line carries the full text
  as an SVG `<title>`, and the full sentence is printed under the diagram.

## Non-goals

- **F-1703** (header = rollup vs Athena rows in the Full view) is a product decision the owner has not
  made; this chain leaves the header logic untouched.
- **F-1704** (Fast-vs-Full attribution divergence) is documented behaviour pending the owner's call.
- `format.ts`, the Latency page, and anything in another open chain's files.
