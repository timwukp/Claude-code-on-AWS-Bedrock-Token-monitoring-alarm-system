# Spec: DORA metrics dashboard (feature-12)

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

1. **Metrics** (per repo, windows 7/30/90 days, tiers Elite/High/Medium/Low, empty → Unknown):
   deployment frequency = merged PRs/day; lead time = median(first commit → merge) with
   p95/mean and coding-vs-review split; change failure rate = (reverts + hotfixes + incident
   issues) / merged PRs, capped 100%; time to restore = median of hotfix open→merge ∪ incident
   open→close. Definitions ported from timwukp/dora-metrics-platform.
2. **Cohorts**: every metric reported for All / AI-assisted / Human-only. AI attribution from
   commit `Co-Authored-By` trailers, bot authors, and PR-body markers (Claude Code / Kiro /
   Amazon Q / Copilot); incidents count only under All (not attributable).
3. **Collection**: scheduled Lambda (6h) pulls merged PRs (+ commits) and bug/incident issues
   via the GitHub REST API with a fine-grained read-only PAT from Secrets Manager
   (placeholder-created; operator fills). Incremental per-repo watermarks; 180-day backfill;
   rate-limit floor stops a run early and resumes next run. Repo registry seeded from config
   once; admins manage it afterwards.
4. **API**: `/v1/dora/repos` (GET; POST admin), `/v1/dora/repos/{owner}/{name}` (DELETE admin),
   `…/sync` (POST admin), `/v1/dora/metrics`, `/v1/dora/overview`. Admin = Cognito `admin`
   group claim, enforced server-side (403 otherwise).
5. **UI**: `/dora` page — repo + window pickers, tier-coloured KPI tiles with AI/Human
   sub-values, weekly deploys (stacked human/AI) + lead-time charts, cohort breakdown,
   recent-PR table with attribution badges, all-repos overview, admin panel. Friendly
   non-alarming states for: no repos, token not configured, first sync in progress, empty window.
6. **QA-loop fixes riding in the same PR** (validated FIXED by the UI-QA agent): Usage page
   reports billed input with prompt-cache tokens as a separate KPI so Usage/Cost/By-Project
   reconcile; the By-Project Full (Athena) view runs async via /v1/queries (new `byProject`
   template) with rows scaled to the shared per-model totals; neutral chart caption; day-carrying
   x-axis labels; OpenAI-on-Bedrock models priced in the rate card (gpt-5.6-sol + gpt-5 fallback).

## Non-goals

Formal deployment events, per-developer profiling, private-repo tokens, cost×DORA join
(the follow-up intent will cover project cost attribution).

## Evals / verification

Backend Jest suites cover the pure metric math (tier boundaries, cohort splits, ISO-week
timeline, classifier corpus from real repos), GitHub client pagination/rate-limit, admin
claim parsing, and the rate-card regression pinning the flagged 46,625-in/4,314,612-out
sample to ~$43.2. Live dev validation and the QA-agent PASS are recorded in
docs/test-reports/feature-12-dora-metrics.md.
