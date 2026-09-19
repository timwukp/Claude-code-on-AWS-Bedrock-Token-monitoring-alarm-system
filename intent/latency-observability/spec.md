# Spec: model-hop latency, with the unmeasured hops drawn as unmeasured

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

### 1. `GET /v1/latency?window=1|7|30`

Authenticated like every other route: the tenant claim must be present. It is **not** used to
filter, because CloudWatch `AWS/Bedrock` has no tenant dimension — the payload says so instead of
implying a scope it does not have.

| Field | Meaning |
|---|---|
| `window` | 1, 7 or 30 days. Any other value → **400**, not a clamp. |
| `scope` / `scopeNote` | `aws-account`, plus the sentence stating there is no project, user or tenant dimension and that per-project latency needs the invocation logs. |
| `fleet.e2e` / `fleet.ttft` | `{p50, p95, p99, samples}` from CloudWatch's own percentile statistics over `InvocationLatency` and `TimeToFirstToken`. |
| `fleet.generation` | `e2e − ttft` per percentile, `derived: true`. |
| `models[]` | The same three stats per `ModelId`, capped at 12 series, sorted by `e2e.p95` descending, and rows with no samples dropped rather than shown as zeros. |
| `hops[]` | The five-hop chain from `hopModel()`: `status: 'measured' \| 'unmeasured'`, a `metric` pointer for measured hops only, a `note`, and for unmeasured hops an `instrument` string naming the telemetry that would light it up. |
| `coverage` | Both sample counts, `streamingPct`, and a sentence explaining why they differ. |
| `caveat` | The refusal: service-side latency of the model call, no productivity claim. |

**Percentiles come from CloudWatch, never from us.** Each `(metric, statistic)` pair is one
`MetricDataQuery` with `Stat: p50 | p95 | p99 | SampleCount` and `Period` equal to the whole
window, so there is exactly one datapoint per query and no client-side averaging of percentiles.

**Missing data is null, not zero.** A metric with no datapoints yields `null` for that percentile,
and the page renders `—`.

### 2. The derived generation segment

`generation.pX = max(0, e2e.pX − ttft.pX)`, `samples` taken from the **TTFT** population, flagged
`derived: true`.

Three properties this pins down, each because getting it wrong would fabricate evidence:

- **Floored at zero.** The two metrics are published over different populations — all invocations
  versus streaming invocations — so at a given percentile first-byte can legitimately exceed
  end-to-end. That is a coverage artefact, and it must surface as `0`, never as a negative duration.
- **`samples` is the streaming count.** Quoting the larger end-to-end count beside a segment that
  only exists for streaming calls would overstate the data behind the number.
- **`derived: true` is load-bearing.** Percentiles are not additive; the page must label the segment
  indicative, not measured.

### 3. `hopModel()` — the contract that keeps the diagram honest

Five hops in request order: `client` → `gateway` → `bedrock-ttft` → `bedrock-generation` →
`guardrails`. Exactly two are `measured`, both inside Bedrock, and each measured hop points at a
**distinct** field of the row.

An `unmeasured` hop **must not carry a `metric`**. This is the single invariant that stops the
diagram borrowing a Bedrock number for a dark hop, and it is asserted in the unit tests rather than
left to review.

The hop table lives in the Lambda, not the page, so the claim ships with the data that backs it.
Each `instrument` string is specific enough to act on, including the trap: LiteLLM's spend-log
`response_time` means end-to-end for non-streaming calls and time-to-first-token for streaming
ones, so it must not be aggregated.

### 4. The `/latency` page

- **Chain diagram, drawn to scale where we can measure and visibly hollow where we cannot.**
  Measured hop boxes take width in proportion to their milliseconds at the selected percentile;
  unmeasured hops get a fixed narrow box, dashed, marked `?` and `not measured`, with the telemetry
  they need written under them. A width proportional to nothing would be an invented number.
  A dot travels the chain, dwelling in each hop in proportion to its measured latency, so the shape
  of the delay is shown rather than asserted.
- **Animation is SMIL** (`<animate>` on `cx`/`cy`/`opacity`) so the component carries no CSS. This
  was originally to avoid a file another session owned; it stays because it keeps the page's one
  novel visual self-contained.
- Controls: window (24 h / 7 d / 30 d), percentile (p50 / p95 / p99), and a model selector.
- Four KPIs — first byte (chip: *streaming only*), generation (chip: *derived*), end-to-end, and
  streaming coverage — each with one line of provenance naming the sample count.
- A by-model table sorted by p95, with the sample count read before the percentiles because a
  low-sample row has a noisy tail.
- A **"What we cannot see yet"** panel listing every unmeasured hop with why it is dark and what
  would light it up. This is on the page face, not behind the disclosure: it is a finding about the
  deployment, not a definition.
- A **"Definitions & limitations"** disclosure (the same native `<details>` component the DORA page
  uses) carrying the OpenTelemetry GenAI vocabulary note, source and scope, why first-byte is
  streaming-only, why the generation segment is derived, and the refusal to show a benchmark.
- **No target and no threshold anywhere.** We hold no distribution to compare against.
- A nav entry under the existing sidebar list, so the page is discoverable rather than URL-only.

### 5. Model labels must not collide

`ModelId` values carry a routing prefix (`us.`, `eu.`, `apac.`, `global.`). The same model reached
through two routes is two CloudWatch series with genuinely different latency.

The API returns both the raw `modelId` and a stripped `label`, and the **page** appends the route
(`… · us`, `… · global`) only to labels that appear more than once. Stripping in the API keeps the
common case readable; disambiguating in the page means a route suffix appears only where it carries
information. Two identically named rows with different numbers read as a bug, so this is a
correctness requirement, not cosmetics.

### 6. Withdrawn rider: token counts past a trillion (qa F-1201)

This spec originally carried the `fmtTokens` fix — the function scaled to `M` and stopped, with no
locale separators, so a cache-read total rendered as `16215.23M`. It **shipped in #50** as that
chain's rider before this one was cut, so it is withdrawn here rather than silently dropped: the
requirement is met, on `main`, and `frontend/src/lib/format.ts` is deliberately not in this chain's
plan. Recorded rather than deleted because a spec that quietly loses a requirement cannot be audited
against the PR that satisfied it.

## Out of scope

- Per-project or per-user latency, and therefore any join to cost, DORA or ROI.
- Athena/Full-view latency (the Glue column does not expose the field).
- A latency tile on the Overview page.
- Alarms, SLOs, thresholds, or any "good / bad" verdict.
- Any statement relating latency to developer productivity, satisfaction or output.
