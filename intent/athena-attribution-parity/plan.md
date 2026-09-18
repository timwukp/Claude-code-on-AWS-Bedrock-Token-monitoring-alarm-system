# Plan: Athena attribution parity (feature-17)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 9274c7f3364dad806a35002ae463f0f4823d4691
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #42 landed, which is this branch's merge base. This
branch is **not** stacked on PR #43 (feature-16, DORA copy density): #43's red `qa` check reported
these two defects, both of which pre-date it and live in files its plan does not name, so the fix
lands on its own chain off `main`. #43 merges as is. Merging #43 first does not move this branch's
merge base.

`intent/dora-canonical-labels/*` is **not** touched here even though #42 shipped it: PR #43 already
carries that status flip, and duplicating it would only conflict.

## Files changed

### Backend — the two Athena surfaces
1. `backend/lambdas/api/queries.ts` — **the query the page's Full toggle actually runs.** Add the
   pure `projectExprFrom(profiles)`, returning `CASE WHEN l.modelId = '<arn>' THEN '<project id>' END`
   with no `ELSE` (so a non-profile call is `NULL` and the `COALESCE` falls through), or `null` when
   nothing resolves. Add `buildProjectExpr()` — the cache read, with the same guard and the same
   failure posture as the existing `buildModelExpr`. `TemplateCtx` gains `projectExpr: string | null`;
   `byProject`'s project column becomes AIP ▷ `project_mapping` name ▷ `requestMetadata` ▷
   `'untagged'`. Export `TEMPLATES` so the emitted SQL is testable.
2. `backend/lambdas/api/queries.test.ts` — four cases: the `CASE` carries no `ELSE`; unsafe, empty
   and `untagged` values are skipped; the AIP tier precedes `requestMetadata` with `untagged` last;
   and with nothing resolved the emitted SQL equals the pre-change statement exactly.
3. `backend/lambdas/api/projects.ts` — the synchronous `/v1/projects` Full path. Extract and export
   `buildFullSql(tenantId, profiles)`, which inlines the cache as
   `WITH profile_map (profile_arn, project_id) AS (VALUES …)`, left-joins it and left-joins
   `project_mapping` on the resolved id for the name and cost centre; `MAX_PROFILE_ROWS = 400`
   bounds the statement. Read `listProfiles()` and `listProjects()` in parallel with the existing
   work; relabel result rows from the registry. Rewrite the docblock: it claimed a precedence the
   code did not implement, and must name the two tiers this path deliberately lacks.
4. `backend/lambdas/api/projects-sql.test.ts` *(new)* — seven cases pinning the CTE, AIP-before-
   metadata precedence, name and cost-centre resolution, the empty-profiles fallback, a single
   `GROUP BY` so `COUNT(DISTINCT user_id)` is never re-aggregated, quote-injection sanitisation
   (asserting the statement's quotes stay balanced), and the row cap against Athena's size limit.

### Frontend
5. `frontend/src/pages/ProjectsPage.tsx` — `mapAthenaProjectRows` takes an optional registry-name
   map and relabels id-labelled rows **before** `mergeProjectRows`, so a project attributed by both
   tiers collapses into one row. The map is built from the `api.projects('fast')` response the Full
   branch already awaits for its totals — no new request. Panel copy replaced per spec §5.
6. `frontend/src/lib/format.ts` — `fmtUsd` gains thousands separators and a pinned `en-US` locale
   (qa F-1102); `fmtSignedUsd` is pinned with it, having the same defect latently.

### CI agent
7. `ci-agent/bugfix_agent.py` — return 0 when no patch applied (the non-zero exit ran under
   `bash -e` and aborted the step before its own `git add`, before its unreachable "no applicable
   patch" branch, and before the comment/stall-detector/fuse steps that own the red verdict);
   `extract_diff` accepts an unterminated fence and trims a hunk line cut mid-write; the prompt asks
   for the diff before the analysis and for no diff at all when the finding is not a local edit.

Non-source riders: `.sdlc/active` → `athena-attribution-parity` (pointer handover),
`intent/athena-attribution-parity/*` (this chain), `CHANGELOG.md`, and
`docs/test-reports/feature-17-athena-attribution-parity.md` plus its index row in
`docs/test-reports/README.md`.

## Commit order

1. `docs(sdlc)`: this chain + the `.sdlc/active` handover.
2. `fix(api)`: `queries.ts`, `projects.ts` and both test files — the attribution tier.
3. `fix(ci)`: `bugfix_agent.py`.
4. **Deploy `Tums-dev-Api`, live-validate, then push 1–3.** The frontend commit must never reach CI
   before the API it reads.
5. `fix(frontend)`: `ProjectsPage.tsx`, `format.ts`. Deploy the frontend, invalidate CloudFront,
   push.
6. `docs`: CHANGELOG + test report + index row; open the PR.

## Verification

- **Gates before any push:** backend `jest` + `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`
  (this repo has no frontend test runner, so the formatter is verified by direct evaluation);
  `cdk synth -c env=ci` (no infrastructure file changes, but CI runs it); `sdlc_ci_gate.py` dry-run
  with every changed source file named above and `Accepted-for` equal to
  `git merge-base github/main HEAD`.
- **Live (dev), same method as features 15 and 16** — no Cognito token is in hand, so the deployed
  Lambdas are invoked directly with an API-Gateway event carrying the real `custom:tenantId` /
  `admin` claims. The load-bearing assertion is a **before/after on real data**: the Full view's
  `untagged` share must fall and profile-routed projects must appear by name, while the Fast view's
  figures stay unchanged. Record both views' totals side by side, and confirm the residual `untagged`
  is accounted for by the two tiers Full cannot resolve rather than left unexplained.
- **Served-bundle check:** fetch the bundle CloudFront actually serves and assert the new copy and a
  separator-formatted figure are present and the superseded "by design" sentence is gone.
- **Leak-scan every push:** no 12-digit account ids, no key material, no customer names.
- Recorded in `docs/test-reports/feature-17-athena-attribution-parity.md`.

## Risks

- **The page's own copy asserted this defect was intentional.** The report must say the copy
  overstated intentionality, not present this as a pure enhancement.
- **Silent degradation is the failure mode to watch.** If the cache read fails, attribution reverts
  to today's behaviour with only a log line. That is the correct trade against failing the page, but
  it means a broken cache looks like a data problem; the warning names the disabled tier so the log
  is diagnostic.
- **Injection surface grows.** Two new SQL fragments interpolate registry-derived strings. Both reuse
  an existing allow-list that admits no quote, and a test asserts the emitted statement's quotes stay
  balanced — but this is the reason the mapping is filtered rather than escaped.
- **Statement size.** The mapping is inlined per query. The cap bounds it; the realistic row count is
  a few dozen.
- **Hardening the bug-fix agent cannot turn PR #43 green.** F-1101 needed an attribution tier that
  did not exist, so a diff-emitting bot was right to refuse. Only this chain closes it.
