# Feature 13 — Project cost attribution × DORA join

| | |
|---|---|
| **Intent** | intent/project-cost-attribution/ (accepted chain; spec addendum records post-acceptance facts) |
| **Branch / PR** | `feat/project-cost-attribution` |
| **Date** | 2026-09-17 |
| **Environment** | `dev` (us-east-1) — live stacks, live API, live CloudFront site, real data |
| **Result** | **PASS** |

## Scope

Per-project Bedrock cost attribution via tagged application inference profiles (AIPs) +
identity, PROJDAY daily rollups aligned to the DORA windows, project registry (tums-tenants),
the DORA-page "Projects — delivery × cost" panel, per-model pricing on the By-Project fast
path, opt-in IAM enforcement + pilot role, and an owner-directed one-time attribution of
pre-profile history. Research: docs/research-project-cost-dora-attribution.md.

## Unit tests / gates

- backend jest **132/132** (+21 for this feature: attribution precedence incl. effective-model
  rewrite, day bucketing + cross-file de-dup, pooled Delivery×Cost rows with per-model pricing
  and notes, registry validation/seed logic, opaque-AIP-ARN pricing guard) · `tsc --noEmit` ✅
- frontend `tsc && vite build` ✅ · infra `cdk synth env=ci` ✅ (11 stacks incl. `Tums-ci-Projects`)
- SDLC CI gate dry-run ✅ (20 source files, all named in the accepted plan; base-bound)

## Live validation (dev, real data)

| Check | Result |
|---|---|
| `Tums-dev-Projects` deployed: 3 AIPs (fable-5-1 / sonnet-4-6 / haiku-4-5-20251001) tagged `tums-project=token-monitoring`; pilot role + managed policy | ✅ |
| **IAM matrix** (pilot role): invoke via tagged AIP → **Allow** ("OK", model claude-sonnet-4-6); direct CRIS id → **AccessDenied**; direct foundation-model id → **AccessDenied** | ✅ |
| Research open question closed: `bedrock:InferenceProfileArn` matches the **AIP ARN** when the AIP wraps a cross-region profile — the two-statement pattern works as designed | ✅ |
| Aggregator resolved the unseen AIP ARN at runtime → registry cache `{token-monitoring, anthropic.claude-sonnet-4-6}` | ✅ |
| Registry seeded on first GET; admin CRUD (201/400/403 paths); 21 projects registered incl. real-name mappings for the legacy demo ids | ✅ |
| PROJDAY live writes (aggregator) + **backfill**: 97,163 objects → 210,865 records → 2,757 daily rollups (2,738 complete-day SET + 19 boundary-day ADD, marker-guarded) | ✅ |
| **One-time historical attribution** (owner-directed): 579-hour commit-correlation map (committed audit artifact); 1,914 (project, model) rows migrated out of `untagged` with equal-and-opposite atomic ADDs; `SYSTEM#RETRO` marker written | ✅ |
| Conservation: post-migration project rows sum 213.34M / $13,476 vs page KPI totals 213.42M / $13,493 (Δ<0.1% = live traffic between reads) | ✅ |
| `untagged` reduced 212.5M → **15.2M (7.1%)** — the unmapped hours, retained honestly | ✅ |
| `GET /v1/dora/projects?window=90`: pooled DORA + windowed cost per project; e.g. Token Usage Monitoring 11 merged PRs · $/deployment $24.40; Agent Skills Best Practice 38 PRs · $7.33 | ✅ |
| By-Project page: 20 named project rows; Fast/Full copy states the managed-vs-immutable split; DORA page renders the Delivery×Cost panel synced to the window picker | ✅ |
| Fixed during validation: CFN GetAtt-by-construct-id; AIP Description charset; dated haiku CRIS id (+ name sanitization); **app-wide `project` billing tag overrides same-key resource tags** → attribution key renamed `tums-project`; backfill parallelized (48-way; sequential was a 12-hour job) and records slimmed (inline request bodies OOMed a 4 GB heap) | ✅ |

## Historical attribution appendix (one-time, owner-directed)

Method: hourly usage buckets × per-repo commit timestamps (21 active repos, 1,777 commits since
June), ±2h window, whole-hour assignment to the repo with the most nearby commits. 90% of
tokens matched (token-weighted); map committed as
`docs/attribution/hour-project-map-2026-09-17.json`. Identity-level pre-split confirmed the
untagged pool was interactive Claude Code only (agent harness roles are separate tenants).
Largest shares landed on Agent Terminal (43.3M), Llmops Agentic System (39.1M), Open Agent
Robot (38.3M), Agentic AI Industry Use Cases (37.8M). Precedence was never overridden for
records carrying real signals; raw logs remain immutable (the Athena Full view keeps call-time
truth). Go-forward attribution runs exclusively on the strict AIP mechanism.

## Operator steps

Done in dev: registry seeded, real-name mappings, pilot routing in local Claude Code settings.
Remaining (owner, one click): Billing console → Cost allocation tags → activate `tums-project`
(real per-project $ appears in Cost Explorer within ~24h). Pilot precedence note: a shell
`ANTHROPIC_MODEL` export overrides repo/local settings env — check a fresh session with /status.

## Verdict

**PASS.** Every layer validated against real data end-to-end: enforceable attribution (IAM
matrix), automatic resolution, daily windows, the DORA×cost join, and an auditable, unrepeatable
one-time treatment of pre-profile history.
