# Plan: latency profile labels (feature-18 follow-up, qa F-PR52-002)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 7c67e8bc9b1089acdb3b5d432d61053fd6586601
- **Status:** accepted

`Accepted-for` is bound to `7c67e8bc` — the tip of `main` after #51 (feature-23) merged, which is this
branch's merge base once that PR is merged in. It was originally cut against `22081a45` (the tip after
#52, the feature this corrects, landed); #51 merged while this PR was in review, so main was merged
into the branch and the binding re-cut. Two rebindings, both recorded rather than rewritten away.

## Files changed

### Backend
1. `backend/lambdas/api/latency.ts` — `resolveLabel()` (pure, exported, the table in spec §2) and
   `ProfileRef`. `listProfiles()` pages `bedrock:ListInferenceProfiles` with
   `typeEquals: 'APPLICATION'` and returns an empty map on any failure. `LatencyRow` gains `via`,
   `profileName`, `resolvedModel`. The old private `label()` becomes `stripRegion()` and is now only
   one branch of the decision. The profile list is fetched concurrently with `ListMetrics`, so the
   change adds no serial latency to the endpoint.
2. `backend/lambdas/api/latency.test.ts` — 7 new cases for `resolveLabel`: a plain model id, a
   region-prefixed id, a profile with one model, a profile listing one model three times, a
   multi-model profile (asserting `resolvedModel` is **absent** and the label is the profile name),
   a multi-model profile with no name (falls back to the id), an unknown id (verbatim, `via` absent),
   and region-stripping applied to the resolved model. Suite goes 21 → 28 cases.

### Infra
3. `infra/lib/stacks/api-stack.ts` — `bedrock:ListInferenceProfiles` added to `LatencyFn`'s existing
   policy statement, resource `*` (the action takes no resource-level permission). No table grants
   are added, so the endpoint still touches no tenant data. This is the only IAM change and it was
   named to, and approved by, the owner before deploying.

### Frontend
4. `frontend/src/api/client.ts` — `LatencyRow` mirrors the three optional fields.
5. `frontend/src/pages/LatencyPage.tsx` — `routeOf()` replaces `scopeOf()` as the disambiguator
   (profile name for profile rows, region prefix otherwise), `shortRoute()` clips it for the picker
   buttons with the full value in `title`, and the table cell gains the `via profile` /
   `multi-model profile` badge. `scopeOf()` stays — it is still the direct-row branch.

## Non-source riders

`CHANGELOG.md` · `docs/ARCHITECTURE.md` (§3.6 and the route table both say this function reads
CloudWatch only, which stops being true) · `README.md` (the "Latency read" bullet makes the same
claim) · `docs/test-reports/feature-18b-latency-profile-labels.md` + its index row in
`docs/test-reports/README.md` · `.sdlc/active` → `latency-profile-labels`.

## Chain handover

This branch points `.sdlc/active` at `latency-profile-labels` and **retires nothing**: PR #51
carried the `latency-observability` retirement, which is now on `main` (that chain reads `shipped`
there), and flipping the same three artifacts in two open PRs would have conflicted for no gain. The
gate requires only that the active chain be fully accepted and cover every changed source file; it
does not require the previous chain to be retired in the same PR. Coordinated with that session while
both PRs were open, and the division held — the only files that did conflict on #51's merge were the
five shared riders, resolved by merging `main` in rather than force-pushing.

## Verification

- Backend `jest` (expect 222 across 21 suites: `main` is 215, plus the 7 new cases) and
  `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`; `cdk synth --context env=ci`;
  `sdlc_ci_gate.py --require-active` with `--changed-files-from` the real diff.
- `cdk diff Tums-dev-Api` read before deploying — the IAM section must show exactly one added action.
- Live: invoke the deployed `LatencyFn` with an API-Gateway event carrying real
  `custom:tenantId` / `admin` claims and assert **zero** rows still carry an opaque id, that each
  resolved row has `via: 'inference-profile'` with a `resolvedModel`, and that `modelId` still holds
  the raw dimension value.
- Confirm the neighbouring endpoints (`/v1/dora/overview`, `/v1/projects?source=fast`) still return
  200 after the deploy.
- Fetch the bundle CloudFront actually serves and assert both badge strings are present.
- Leak-scan every push: no 12-digit ids, no ARNs, no key material, no customer names.

## Risks

- **An Api deploy from any tree cut before this change removes the new grant.** The dev environment
  has one Api stack, so deploying it from `main` reverts the policy. It degrades to raw ids rather
  than failing, which makes it silent. #51 agreed not to deploy Api while both PRs were open; from
  its merge until this lands, `main`'s Api tree no longer carries the grant, so the live state must be
  re-asserted after any deploy from `main`.
- **`.sdlc/active` is a single mutable pointer.** #51 was open against the same value and landed
  first, so this branch re-derives from `overview-page`. The gate emits that as a note, by design.
- **Profile names are customer-chosen strings** rendered verbatim in the table. Nothing about them is
  committed to the repo, and no fixture in this change uses a real one.
