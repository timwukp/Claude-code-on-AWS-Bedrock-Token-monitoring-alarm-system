# Spec: QA CI boundaries

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour
1. `ci-agent/qa_agent.py`:
   - `origin_of(url)` → `scheme://host:port` (default port explicit), or '' for anything but http(s) or a bad port.
   - `allowed_origins(raw, fallback_url)`: origins from the comma-separated list. Only an empty list falls back to
     the fallback URL's origin; a list that is set but holds no valid origin allows nothing.
   - `target_problem(url, admin_pages, origins)`: refuses when no origin is allowed, when the target's origin is not
     allowed, or when an admin page is not on the target's origin.
   - `--allowed-origins` (default env `QA_URL_ALLOWLIST`; when empty, env `TARGET_URL`'s origin). `main()` checks
     before creating the harness client. On a problem, `refuse_target` prints `::error::`, writes an UNKNOWN report
     with the reason, writes `overall=UNKNOWN blocking=false progress=true` (no `readonly`/`persona`), publishes nothing
     to S3, and exits 2.
2. `ci-agent/test_agents.py`: origin normalisation, the fallback rule, `target_problem`, and `main()` refusing an
   off-list URL, a missing list, and an off-origin admin page with zero harness calls and zero uploads; the env list and
   the `TARGET_URL` fallback both admit the target. The existing end-to-end tests pass `--allowed-origins`.
3. `.github/workflows/ui-qa-agent.yml`: the trust-boundary comment says what the boundary stops (a PR's code) and what
   it does not (a same-repo PR author, who can change this file for its own run); the `contents: write` comment states
   the ruleset as it is; the dispatch `url` input is optional with an empty default; `QA_URL_ALLOWLIST` comes from the
   repo variable of that name.
4. `SECURITY.md`: the three relied-on settings each marked not applied, with the evidence; a bullet for the allow-list.
   `docs/test-reports/feature-47-…md`: a dated correction under the Phase 0 sentence. `AGENTS.md` rule 4: one sentence.

## Acceptance
- Unit: `python3 -m unittest test_agents` — 43 tests (32 before) on Python 3.12 and 3.14; a mutation pass over the new
  guards with every non-equivalent mutant killed; the 24 PR #122 mutants still killed.
- Live (no login, no agent call): one `workflow_dispatch` with a URL off the allow-list ends red at the QA step with
  "refused to start", and the job log shows no harness invoke.
