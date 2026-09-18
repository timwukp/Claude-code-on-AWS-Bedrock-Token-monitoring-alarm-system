# Feature 16 — DORA copy density: one card, one measurement

- **Branch:** `feat/dora-copy-density` (cut from `9274c7f`, the tip of `main` after PR #42)
- **PR:** TBD
- **Intent chain:** `intent/dora-copy-density/{intent,spec,plan}.md`
- **Evidence:** `docs/research-dora-card-copy.md` — 8 findings, each with a 3-vote adversarial tally
  and source URLs
- **Date:** 2026-09-18
- **Verdict:** PASS

## Two things this report has to say plainly

1. **This reverses a decision PR #42 shipped two days ago.** #42 promoted the 2024 ordinal band to
   the card headline. DORA's own live instrument (the Quick Check) scores software delivery
   performance on a continuous scale against an industry mean, and `Elite`/`High`/`Medium`/`Low`
   appear **zero** times as labels in its bundle; the September 2025 report has zero occurrences of
   "elite"/"high performer"/"low performer" and 75 of "cluster". Dating the band was right. Leading
   with it was not. This is a correction, not a polish pass.
2. **Terseness itself is a design judgement, not a research finding.** Three of the five research
   angles produced no usable evidence: there is no empirical finding that long caveat text harms
   comprehension, no confirmed vendor pattern for proxy disclosure, and no DORA-sanctioned term for
   AI-authored share. The density rule in this feature is justified on scanability and credibility
   grounds, and neither the page nor this report dresses it as evidence-backed.

## Scope

Rule enforced across the DORA page: **one card = one canonical noun label + at most one qualifier
chip + one number + one line of sample provenance.** Everything else moved behind one accessible
disclosure. No computed metric value changed; no new data source; no benchmark, percentile or
archetype appears anywhere on a card face.

| Group | Label | Chip | Value | Provenance line |
|---|---|---|---|---|
| Throughput | Deployment frequency | `proxy` | `1.4 / week` | `6 merges to main · 30 days` |
| Throughput | Change lead time | `partial` | `1.6 h` | `median first commit → merge · 6 changes` |
| Stability | Change fail rate | — | `0%` | `0 of 6 changes reverted, hotfixed or tied to an incident` |
| Stability | Recovery time | `not DORA's` | `—` | `no hotfixes or incidents in this window` |
| Stability | Deployment rework rate | `not collected` | `—` | `needs a planned-vs-corrective deployment signal` |

The AI metric left the DORA grid and heads the cohort panel as **AI-assisted changes**, named for
what it counts (PRs carrying an AI co-author trailer), because no DORA metric covers AI-authored
share and keeping it among the five implied a sanction that does not exist.

## Unit tests and gates

| Gate | Result |
|---|---|
| Backend `jest` | **167 passed** (18 suites) |
| Backend `tsc --noEmit` | clean |
| Frontend `tsc --noEmit` | clean |
| Frontend `vite build` | clean — `assets/index-Dk0UMe57.js`, `assets/index-ioUJXhEW.css` |
| `sdlc_ci_gate.py` | PASS — every changed source file named in `plan.md`; `Accepted-for` == merge base `9274c7f…` |

New tests, all in `backend/lambdas/dora/dora-calc.test.ts` for `BANDS_2024_REFERENCE`:

- it covers exactly the metrics that have a tier (`df`, `lt`, `mttr`) and **never** `cfr` — a
  change-fail row would re-assert the tier this codebase deliberately refuses;
- four levels per metric, best first, and **no band text may contain a digit**. A digit means the
  fallback rendering fired, i.e. a threshold moved without its wording — the table would then read
  as arithmetic rather than as a benchmark;
- the exact expected strings per metric, including `label === 'Failed deployment recovery time'`,
  which is deliberately *not* what our `mttr` field computes;
- agreement with `tierFor` at every published boundary.

The reference table is **derived from `TIERS`** rather than duplicated, so the disclosure's numbers
cannot drift from the ones the tiers are computed from, and `cfr` is excluded by construction.

## Live validation (dev)

`Tums-dev-Api` deployed 09:32. There is no Cognito token in hand, so — exactly as in feature-15 —
the deployed `DoraFn` was invoked directly with an API-Gateway-shaped event carrying the real
`custom:tenantId` and `admin` claims. Same deployed code, same live tables; only the token exchange
is skipped.

| Check | Result |
|---|---|
| `/v1/dora/metrics`, `/overview`, `/projects` | 200 |
| `changeFailureRate` anywhere in any payload | **0 occurrences** |
| `changeFailRate` on the metrics payload | present, with `reverts`/`hotfixes`/`incidents`/`failures` |
| `dataSource.canonicalSource` | `https://dora.dev/guides/dora-metrics/` |
| `dataSource.bandReference` | `df`, `lt`, `mttr` only — no `cfr` row |
| `dataSource.notes` | 15 notes, one claim each; the "band leads, rate is supporting arithmetic" note **gone** |
| `overview` rows | 6 repos, `cfr.tier` `Unknown` at 0% |
| `projects` rows | 21 projects, 6 with DORA data |

`bandReference` as served:

| Metric (DORA's name) | Elite | High | Medium | Low |
|---|---|---|---|---|
| Deployment frequency | at least once per day | at least once per week | at least once per month | less than once per month |
| Change lead time | within one day | within one week | within one month | more than one month |
| Failed deployment recovery time | within one hour | within one day | within one week | more than one week |

The frontend was then built, synced to the dev site bucket, and CloudFront `E109P5BP3CW3XT`
invalidated. The **served** bundle was fetched back from CloudFront and asserted string by string.

Present: `Software delivery throughput` · `Software delivery stability` · `Deployment frequency` ·
`Change lead time` · `Change fail rate` · `Recovery time` · `Deployment rework rate` ·
`not collected` · `AI-assisted changes` · `carry an AI co-author trailer` ·
`Definitions & limitations` · `AI-assisted vs human-only` · `2024 performance levels, for reference
only` · `median first commit → merge` · `not DORA's` · the `.disclosure` CSS rules.

Absent: `How often do changes reach main` · `How long from first commit to main` · `How often does a
change need a revert or hotfix` · `How long to recover once something breaks` · `5th DORA metric` ·
`How much did AI help write it` · `About weekly` · `About daily` · `2024 DORA band` ·
`Lead time breakdown` · `Deploy freq. (proxy)` · `DORA's own wording` · `Elite (2024)` ·
`place a band` · `How these are measured` · `changeFailureRate`.

Two remaining occurrences of the substring "no band" were inspected individually: both are new
disclosure prose ("uses no band as a label", "no band is derived from it"), not the deleted badge.

**Caveat relocation audit** — every caveat string removed from a card face was traced to its new
home, because relocating a caveat can silently become deleting it:

| Caveat removed from a face | Now lives in |
|---|---|
| five metrics, four measurable | disclosure note 1 |
| merge-as-deployment proxy + DORA's own tooling warning | `METRIC_MAP` row 1 + `deploymentDefinition` |
| lead-time end point is merge, not production | `METRIC_MAP` row 2 + note 6 |
| "0% means nothing matched those detectors" | `METRIC_MAP` row 3 + note 8 |
| recovery-time scope is not DORA's | `METRIC_MAP` row 4 + note 9 |
| rework rate needs a planned-vs-corrective signal | card face (coverage) + `METRIC_MAP` row 5 + note 2 |
| 2024 bands are annual survey benchmarks, not grades; 2025 replaced them | band section prose + note 13 |
| change-fail bands are non-monotonic, so no tier is derivable | band table prose + note 14 |
| AI-trailer definition; incidents count only under All | notes 10–12 + the cohort table caption |
| both table captions about bands and published values | the band reference table |

## Accessibility

The disclosure is a native `<details>/<summary>`, so it opens by keyboard (Enter/Space on a focused
`summary`) and by touch with no ARIA wiring and no hover dependency — a hover-only tooltip cannot
carry information a reader needs (NN/g; WCAG 1.4.13). `summary:focus-visible` gets a visible
outline, and the marker is replaced with a rotating caret rather than removed.

**Gap, same as feature-15:** the rendered page was not driven in a real browser this round —
`playwright-mcp` failed to connect (`CONNECTION_CLOSED`). The assertion above is on the served
markup and stylesheet, not on an observed keyboard interaction.

## Also in this change

- `frontend/src/pages/RoiPage.tsx:146` — the ROI break-even card said "against **a** org-default
  team size" (qa finding F-1101 on PR #42). Now `an org-default` / `a code-default`. It rides here
  because the SDLC gate requires every changed source file to be named in the active plan, and #42's
  plan did not name that file; this chain is a wording pass anyway.
- `backend/lambdas/api/roi.ts` consumes the renamed change-fail field as its second consumer. It was
  missing from the first draft of `plan.md` and was added there before the code was pushed — the
  gate would otherwise have failed on an uncovered source file.

## Leak scan

Every pushed file scanned for 12-digit account ids, `AKIA`/`ASIA` prefixes, IAM ARNs, private-key
headers and customer names: **clean**. No environment configuration was committed.
