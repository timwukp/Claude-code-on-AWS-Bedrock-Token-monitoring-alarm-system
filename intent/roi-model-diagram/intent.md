# Intent: show the ROI model as a picture, with this project's numbers in it

- **Slug:** roi-model-diagram
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The AI ROI page computes a number whose model has no authoritative definition in the industry.
The page is already honest about that in prose — a "How to read this page" paragraph, a list of
refusals, a methodology document — but prose is the weakest carrier for a model that is really a
small graph: measured inputs and configured assumptions flow into a Value side and an Investment
side, and the result is a ratio. A reader who is not a DORA expert has to hold nine terms in their
head to follow the paragraph; the owner's verdict after the live audit was that the page "needs a
picture".

Two further defects surfaced while drawing it:

1. **"J-curve" appears on the page three times and is defined nowhere on it.** The term is DORA's
   own label for the adoption-period productivity dip in its first-year ROI calculator. It is a
   common concept in economics but not a standard cost line in any other AI-ROI framework
   (Forrester TEI, GitHub's calculator use "ramp-up" or "learning curve"). An engineering manager or
   FinOps reader cannot be assumed to know it.
2. **The same term is API-supplied copy.** `backend/lambdas/api/roi.ts` ships the methodology
   string `one-time costs (training, J-curve) do not`, which the page renders inside "What this page
   refuses to compute". Renaming the frontend alone leaves the old word reachable from the backend.

## Evidence and judgement

- The component itself was hand-deployed to the dev environment for the 2026-09-18 customer demo,
  on the owner's instruction, and reviewed live; this chain is the formal landing of that work, not a
  new design.
- The wording review used the assumption-mapping method on the J-curve line. Verdict: the *concept*
  is defensible (DORA 2024 documents the dip; it counters the bias of counting benefits without
  transition cost), the *default magnitude* (15 % for 3 months) is a DORA convention rather than a
  measured result, and two methodological weaknesses stand — a learning cost belongs to people, not
  projects, so a shared team is charged once per project; and the model is "first-year" while this
  portal computes on rolling windows indefinitely. This chain fixes the wording and states both
  caveats on the diagram; the two model weaknesses are recorded for a later chain, not silently
  fixed here.
- The picture is **inline SVG, not PNG**: it follows the theme tokens, stays crisp at any density,
  keeps its text selectable and readable by assistive technology, and — decisively — it is **live**:
  every box shows the selected project's own number, tagged *measured*, *assumed* or *derived*,
  and components the page refused to compute are faded with the refusal reason. A static picture
  could not show a reader which of the numbers in front of them were measured.

## Desired outcome

- On `/roi`, inside "How to read this page", a project selector and a diagram: three input columns
  (measured · assumptions · model), Value and Investment totals, the ROI formula and result, the
  break-even line, a legend, and a provenance footer naming DORA's calculator and the three RCTs.
- "J-curve" is replaced by **"Adoption dip"** everywhere a reader sees it — the diagram, the
  waterfall label, and the API methodology string — with the original term kept once in
  parentheses so readers who know DORA's model can map it.
- One sentence on the diagram defines the term: temporarily slower while learning the tool,
  one-time, first year only, off by default, editable per project.

## Non-goals

- No change to any computed value; `roi-calc.ts` is untouched.
- No fix to the per-project double counting or the first-year-only applicability of the adoption
  dip — both are stated as caveats and left for a chain that can change the arithmetic.
- No help panel yet; that primitive arrives with `ux-foundation`, and this diagram's definitions
  will move into it then.
