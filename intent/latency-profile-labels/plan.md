# Plan: latency profile labels (feature-18 follow-up, qa F-PR52-002)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 22081a45a41077c6f2f0125ce388fffb521d6717
- **Status:** accepted

`Accepted-for` is bound to `22081a45` — the tip of `main` after #52 (feature-18) merged, and this
branch's merge base. #52 merged while this fix was being built, which is why it is a follow-up branch
rather than another commit on that PR.

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

`.sdlc/active` on `main` at `22081a45` names `latency-observability`. This branch points it at
`latency-profile-labels` and **deliberately does not retire `latency-observability`**: PR #51
(concurrent, already built and green) carries that retirement, and flipping the same three artifacts
in two open PRs would conflict for no gain. The gate requires only that the active chain be fully
accepted and cover every changed source file; it does not require the previous chain to be retired in
the same PR. Coordinated with that session directly.

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

- **A concurrent Api deploy from another branch would remove the new grant.** The dev environment has
  one Api stack, so deploying it from a tree cut before this change reverts the policy. It degrades
  to raw ids rather than failing, which makes it silent — flagged to the concurrent session, which
  agreed not to deploy Api until this lands.
- **`.sdlc/active` is a single mutable pointer** and #51 is open against the same value; whichever
  lands second re-derives. The gate emits this as a note on every handover, by design.
- **Profile names are customer-chosen strings** rendered verbatim in the table. Nothing about them is
  committed to the repo, and no fixture in this change uses a real one.
