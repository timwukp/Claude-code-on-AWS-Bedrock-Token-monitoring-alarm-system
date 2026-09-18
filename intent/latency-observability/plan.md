# Plan: latency observability (feature-18)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** c55ceb0ed5345bc43a801f1510bd40d80ae5fa9f
- **Status:** shipped

`Accepted-for` was left unbound while this chain sat last in an agreed queue (#43 → feature-19 →
feature-20 → this), because the base did not exist yet; the sdlc gate fails closed on an unbound
value, which is the intended safety net rather than a step to remember. It is now bound to
`c55ceb0` — the tip of `main` after #50 merged, and this branch's merge base. The queue ahead of it
has fully landed (#43 dora-copy-density, #44 athena-attribution-parity, #49, #50 anomaly-key-shape),
so this chain is stacked on nothing and retires `anomaly-key-shape`, which is what `.sdlc/active`
names on `main` at `c55ceb0`.

## Files changed

### Backend
1. `backend/lambdas/api/latency.ts` — **new**. `GET /v1/latency?window=1|7|30`. Reads CloudWatch
   `AWS/Bedrock` `InvocationLatency` and `TimeToFirstToken` via `GetMetricData` with native
   `p50`/`p95`/`p99`/`SampleCount` statistics, once with no dimension (fleet) and once per `ModelId`
   from `ListMetrics` (capped at 12 series). Exports `hopModel()` (the five-hop chain, two measured)
   and `deriveGeneration()` (`e2e − ttft` per percentile, floored at zero, `derived: true`).
   Window validation returns 400 rather than clamping.
2. `backend/lambdas/api/latency.test.ts` — **new**. 21 cases over the three pure functions:
   `deriveGeneration` — subtraction against the measured fixture, streaming sample count rather
   than the end-to-end one, floor-at-zero when TTFT exceeds E2E, per-percentile null isolation,
   all-null on an empty window, and the `approximated` flag propagating from either input.
   `combineBuckets` — a single bucket stays exact and unflagged, several buckets collapse to a
   sample-count-weighted mean and are flagged `approximated`, zero-sample buckets are ignored rather
   than diluting the mean, and an empty series yields nulls. `hopModel` — chain order (the page draws
   straight from the array), exactly two measured hops and both inside Bedrock, a distinct `metric`
   per measured hop, **no `metric` on any unmeasured hop**, `instrument` text present on all three
   dark hops, the LiteLLM `response_time` warning, and a fresh array per call.

### Infrastructure
3. `infra/lib/stacks/api-stack.ts` — `LatencyFn` (`NodejsFunction`, 512 MB / 20 s, modelled on
   `DoraFn`) and the `v1/latency` GET resource. IAM is `cloudwatch:GetMetricData` +
   `cloudwatch:ListMetrics` only — **no table grants**, because the endpoint reads no tenant data.

### Frontend
4. `frontend/src/pages/LatencyPage.tsx` — **new**. The chain diagram (SMIL animation, so no CSS of
   its own), window / percentile / model controls, four KPIs, the by-model table, the
   "What we cannot see yet" panel, and the "Definitions & limitations" disclosure. Includes
   `scopeOf()` + the `ambiguous` label set so two routes of one model never render as duplicate rows.
5. `frontend/src/api/client.ts` — `LatencyStat`, `LatencyRow`, `LatencyHop`, `LatencyResponse` and
   `api.latency(window)`.
6. `frontend/src/main.tsx` — `PAGE_META['/latency']` and the route.
7. `frontend/src/components/Layout.tsx` — one nav entry in the **Delivery** group,
   `{ to: '/latency', label: 'Latency', icon: 'timer' }`. The nav rework landed ahead of this chain,
   so the entry adopts the shipped `NavItem` shape and the existing `timer` glyph from `Icon.tsx`
   rather than introducing an emoji or a new path; this is the only line of this chain in that file.

`frontend/src/lib/format.ts` was in this plan's earlier draft for the `fmtTokens` `B`/`T` tier fix
(qa **F-1201**). It **shipped in #50 instead**, as that chain's rider, so it is deliberately dropped
here: two open plans naming one file is exactly what the sdlc gate is meant to catch, and the fix is
already on `main`.

### Non-source riders
`docs/research-latency-measurement.md` (the evidence, already written) · `.sdlc/active` →
`latency-observability` · `intent/latency-observability/*` (this chain) ·
`intent/anomaly-key-shape/*` → `shipped` — all three files together, since the gate reads the
intent → spec → plan ladder and flipping only `intent.md` fails as "a stage was skipped". That is
the chain `.sdlc/active` names on `main` at `c55ceb0`, re-derived rather than carried over from the
earlier draft, which still named the already-retired `dora-copy-density` and
`athena-attribution-parity` chains · `CHANGELOG.md` · `docs/ARCHITECTURE.md` (the route, the
CloudWatch read, the hop model) · `README.md` (bullet + endpoint recount) · `docs/ROADMAP.md` ·
`docs/test-reports/feature-18-latency-observability.md` + its index row.

## Commit order

1. `docs(sdlc)`: chain + `.sdlc/active` handover + the research doc + the `anomaly-key-shape` flip.
2. `feat(latency)`: `latency.ts` + `latency.test.ts`.
3. `feat(infra)`: `api-stack.ts`.
4. **Deploy `Tums-dev-Api`, live-validate, then push 1–3** — the frontend commit must never reach
   CI before the API it calls.
5. `feat(frontend)`: page, client, route, nav. Deploy the frontend, invalidate CloudFront, push.
6. `docs`: CHANGELOG / ARCHITECTURE / README / ROADMAP + the test report and index row; open the PR.

## Verification

- **Gates before any push:** backend `jest` + `tsc --noEmit`; frontend `tsc` + `vite build`;
  `cdk synth env=ci`; `sdlc_ci_gate.py` dry-run — every changed source file named above and
  `Accepted-for` equal to the merge base.
- **Live (dev):** invoke the deployed `LatencyFn` with an API-Gateway event carrying the real
  `custom:tenantId` / `admin` claims, as features 15–17 did. Assert non-null percentiles for both
  metrics, per-model rows present, an out-of-range window → 400, and that `/v1/dora/overview` +
  `/v1/projects?source=fast` still return 200 after the deploy.
- **Percentiles proven, not assumed:** cross-check the Lambda's fleet numbers against a direct
  `get-metric-statistics --extended-statistics` call for the same window; they must agree to
  rounding.
- **The `approximated` flag must be observed, not just unit-tested:** a 7-day window and a 30-day
  window over the same live data must differ in whether they carry it, or the flag proves nothing.
- **Served-bundle check:** fetch the bundle CloudFront actually serves and assert the page's strings
  are present. Note that the hop labels will **not** appear in the bundle — `hopModel()` lives in the
  Lambda and the page renders `data.hops` — so the bundle check covers the page's own copy and the
  API path, and the hop wording is asserted on the API response instead.
- **Known verification gap, to be stated in the report as feature-15 did:** no browser render check.
  There is no Cognito session in hand — credential extraction from the transcript was denied
  earlier and is not retried — so evidence is bundle-, HTTP- and Lambda-level only.
- **Leak-scan every push:** no 12-digit account ids, no key material, no customer names.

## Risks

- **The diagram is the risk.** A chain drawn to scale invites the reader to believe every hop is
  measured. Mitigations are structural rather than editorial: unmeasured hops get a fixed width and
  no number, `hopModel()` forbids a `metric` on an unmeasured hop, and the unit tests assert that
  invariant. If a future change wants to size a dark hop, it has to delete a test to do it.
- **The generation segment is arithmetic on percentiles, which is not valid arithmetic.** It ships
  because the shape is useful, flagged `derived` in the payload, chipped *derived* on the card and
  explained in the disclosure. If that labelling is ever dropped, the number becomes a fabrication.
- **Fleet-only data invites a per-project reading.** The page says the scope in the disclosure and
  the API says it in `scopeNote`; neither may be softened. Per-project latency is a separate chain
  and the rollup work it needs is written up in the intent's non-goals.
- **`Layout.tsx`, `main.tsx` and `client.ts` are contested files, and one concurrent PR touches
  them.** PR #51 (feature-23, the Overview landing page) adds its own nav entry, route and client
  method in the same three files. Both sets of edits are single additive lines in distinct places, so
  the textual conflict is small, but whichever PR lands second has to re-run its gates on the new
  base rather than assume they carry. The `format.ts` contention is gone: that fix shipped in #50.
- **`.sdlc/active`, `CHANGELOG.md` and the test-report index conflict between every pair of
  concurrent PRs in this repo**, and a conflicting PR runs **zero** checks rather than red ones,
  because GitHub has no merge ref to build. So `gh pr view --json mergeable` is checked immediately
  after opening, before any waiting on CI.
- **CloudWatch series cap.** `ListMetrics` is truncated to 12 `ModelId` series, so a fleet using
  more models shows an incomplete by-model table while the fleet row stays correct. Acceptable for
  a first cut; it needs pagination before it is a customer-facing promise.
