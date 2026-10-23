# Feature 41 — OpenAI rates from their model cards; no $0 estimate is silent

- **Chain:** `intent/openai-rates-and-unpriced/` · **Branch:** `feat/openai-rates-and-unpriced` off `main@dc60133` (post-#73) · **PR:** #74
- **Origin:** the gateway study's chain A, reordered after C (feature-40) by the owner; qa F-PR73-N02 (gpt-5.6-luna
  labelled `gpt-5`) is its visible symptom.
- **Date:** 2026-10-23
- **Verdict:** PASS on gates and on a local run of the new handlers against the live tables (the Api is not yet
  redeployed; see Live). Owner deploys Api (+ Etl for the aggregator's identity-hint change) after review.

## What this report has to say plainly
- **The `gpt-5.6-sol` row was a guess and it was wrong by 3.2×.** Feature-36 priced it at $1.25 / $10 per MTok "from the
  GPT-5 family". Its AWS model card (read 2026-10-23) says **$4 / $20** (Global CRIS; In-Region and Geo CRIS ×1.1). The
  608 August calls on this account are ≈ $103.25, not $47.5. Every OpenAI frontier model now has a row from its card;
  the sources, with dates and the Price List cross-check for Astra, are in `docs/research-openai-pricing-sources.md`.
- **AWS has billed this account $0.00 for every OpenAI model, ever.** Whole bill 2026-06-01 → 10-22, every SERVICE,
  3 pages: every OpenAI line is $0 with non-zero quantity, and gpt-5.6-sol has no line at all. Feature-38 footnoted this
  model as "cannot be checked against this bill"; now it can — and the list price exceeds the bill by its whole amount.
  The card keeps the published rates (another account is charged them); the bill panel flags such rows `billedZero` and
  sums the surplus. The owner's all-time Cost figure rises ≈ $56 for usage AWS never charged — this report says so.
- **Six models had been silently free.** deepseek-r1, two kimi, llama3-8b, ministral-3b and nova-pro — one call each,
  ≤ 462 tokens — sat in every total at $0 with nothing on any page saying so. They are now listed as "unpriced" on the
  Cost, Overview and Projects pages with their tokens and calls. The generic `gpt-5` row, which would have hidden any
  future GPT id the same way, is removed.
- **`matchRate` is order-independent.** Longest key wins; the Athena rate CASE tests keys longest-first. A reversed
  card gives the same rows (test).
- **One identity hint per role.** `arn:aws:iam::<acct>:role/<r>` (or the session-less `assumed-role/<r>`) attributes
  every `assumed-role/<r>/<session>` caller. Exact session hints still win; paths are not guessed; another account's
  same-named role does not match.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/cost-calc.ts` (+3 tests) | longest-key `matchRate`; `cardByKeyLength`; `isPriced`; `collectUnpriced`; `TokenCounts.invocations`; `CostSummary.unpricedModels`; `gpt()` row helper; six card rows + gpt-oss ×2; `gpt-5` row removed |
| `backend/lambdas/api/queries.ts` (+tests) | `rateCase` iterates `cardByKeyLength`; regression: longer keys first, no `gpt-5` LIKE |
| `backend/lambdas/api/costs.ts`, `projects.ts` | rows carry `invocations`; `unpricedModels` on the response; `hasUsage` ignores `invocations` |
| `backend/lambdas/api/overview-calc.ts` (+test) | `unpricedModels` from the current window |
| `backend/lambdas/api/bill-calc.ts` (+test) | `billedZero`, `billedZeroEstimateUsd`, logged share = Σ min(billed, logged) / Σ billed |
| `backend/lambdas/ingestion/parse.ts` (+tests) | `identityHintKeys`, `lookupIdentityHint`; tier 3 of `deriveProject` |
| `frontend/src/components/UnpricedNote.tsx` (new), `CostsPage`, `OverviewPage`, `ProjectsPage` | the unpriced note; "billed $0" badge + sentence on the bill panel; spend-tile suffix |
| `GovernancePage`, `OverviewPage`, `help-content.ts` | Budget-vs-bill scope sentence (peer request) |
| `SettingsPage`, `ProjectsPage` | identity-hint copy mentions the role rule |
| `docs/research-openai-pricing-sources.md` (new), `RECONCILIATION.md`, `VERIFICATION.md`, `CHANGELOG.md` | provenance, residuals, card rule |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 412/412, 31 suites (+14 tests: card figures per model, longest-key on a reversed card, SQL order, `collectUnpriced`, `billedZero`, role hints) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — 10 stacks |
| `sdlc_ci_gate.py --require-active` | PASS — every changed file named in the plan; approval bound to `dc60133` |
| `scripts/check-rate-card.ts` | OK — no drift on the Claude rows (OpenAI rows are outside its Price List check; their sources are the model cards, dated above) |
| Leak scan | clean (12-digit ids: fixture ids only; sensitive values; customer names) |

## Live — the new handlers run locally against the real tables, owner's claims (Api not yet redeployed)
| Check | Result |
|---|---|
| `/v1/costs` total (all time, owner tenant) | $29,042.52; `us.openai.gpt-5.6-sol` **$103.25**, `routeMultiplier` 1.1 (deployed code: ≈ $47.5) |
| `unpricedModels` on `/v1/costs` = `/v1/projects?source=fast` | 6 rows: `us.deepseek.r1-v1:0` (462 tokens, 1 call), `moonshot.kimi-k2-thinking` (46, 1), `moonshotai.kimi-k2.5` (31, 1), `meta.llama3-8b-instruct-v1:0` (20, 1), `mistral.ministral-3-3b-instruct` (9, 1), `amazon.nova-pro-v1:0` (2, 1) |
| `unpricedModels` on `/v1/overview?window=90` | the same minus nova-pro (its one call is older than 90 days) — the window filter works |
| `bill` block | `billedZero` rows: none yet — the collector holds 10-01 onward and October OpenAI usage prices < $0.005; the August gpt-5.6-sol usage would flag once the bill is backfilled to June (offered to the owner as a one-off collector invoke; ≈ 5 CE requests) · `loggedSharePct` 87.3 on the 10-01 → 10-22 bill under the per-model cap |
| Cost Explorer, whole account history | OpenAI: $0.00 on every line, every service (see research note) |

## Known limits, stated rather than fixed
- Long-context OpenAI calls (> 272K input) bill 2× input / cache and 1.5× output; the rollups cannot tell them apart —
  the estimate is a floor for such calls.
- The Athena (Full) `/v1/projects` path prices in SQL and carries no `unpricedModels` list; the Fast path does.
- Pricing Bedrock Mantle tokens stays out of scope (no cache split; feature-40).
