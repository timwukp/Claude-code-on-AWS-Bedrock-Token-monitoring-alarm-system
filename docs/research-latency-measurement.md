# Research: should the product measure end-to-end latency, and from where?

- **Date:** 2026-09-18 · **Method:** deep-research harness (104 agents, 5 angles, 3-vote adversarial
  verification per claim; 8 findings survived, 8 refuted) + one direct inspection of live data that
  settled the harness's only unresolved conflict.
- **Trigger:** an anonymised enterprise (~$1M+/yr AI spend, 400+ developers; Claude Code / IDE agents
  → LiteLLM gateway → Amazon Bedrock → Bedrock Guardrails → model) says latency is their current
  focus and asks what other companies measure across cost, latency and feature parity.
- **Question, framed critically first:** the request carries five assumptions — (A1) one customer's
  focus = market demand, (A2) end-to-end latency is observable from our data, (A3) latency changes
  developer outcomes, (A4) "latency" is one number, (A5) adding it is net positive. Each angle below
  tests one of them. Angles 3–5 produced **no** surviving evidence; that is a result, not a gap.

## Verdict

**Yes — add latency, scoped to what is observable, and label it diagnostic, not a productivity
driver.** Two facts make this cheap and honest:

1. **The invocation logs we already ingest carry per-request latency.** For streaming calls (which is
   what Claude Code makes — 10 of 12 sampled records), the final chunk of
   `output.outputBodyJson` holds `amazon-bedrock-invocationMetrics.{invocationLatency,
   firstByteLatency}` in milliseconds. Non-streaming `InvokeModel` records have no latency field.
   This was **verified on live records**, not documentation — the harness had this claim refuted
   0-3 and confirmed by another verifier in the same round, so it was checked by hand. Consequence:
   **p50/p95 end-to-end and time-to-first-byte per project, per model, per day fall out of the same
   pipeline and the same four attribution tiers the cost figures use.** No new data source, no new
   agent, no gateway dependency.
2. **The metric vocabulary is settled** (finding 1): TTFT · time-per-output-token · end-to-end
   duration, as histograms so p50/p95/p99 can be read. Codified in the OpenTelemetry GenAI semantic
   conventions and mirrored by LiteLLM, Langfuse, Datadog and Bedrock CloudWatch. Adopt the names;
   do not invent our own.

What must **not** be claimed: that these numbers explain developer adoption or output. No
independent evidence for that survived verification (angle 3). The card copy must say "service-side
latency of the model call" and nothing about productivity.

## Findings (verified)

| # | Finding | Conf. | What it means for us |
|---|---|---|---|
| 1 | Standard triad = TTFT / TPOT / E2E as histograms (OTel GenAI conventions, status *Development*; Langfuse `completionStartTime`; Datadog `time_to_first_token`). Client-side OTel names added Feb 2026 have ~0 adoption yet. | high 3-0 | Use the OTel names for our fields and copy; expect upstream tools to use their own. |
| 2 | LiteLLM exposes per-stage Prometheus histograms — total, upstream LLM API, TTFT (streaming only), gateway overhead, ASGI queue — with team/key/model labels. **Bedrock-native Guardrails time is inside the "LLM API" segment, not separable there.** No native `project` label; the AIP ARN appears in the `model` label so a join to our registry is feasible. | high 3-0 | The gateway is where *per-hop* decomposition lives; our logs give the Bedrock hop only. |
| 3 | LiteLLM's `response_time` in spend logs is **overloaded**: E2E for non-streaming, TTFT for streaming. Correct E2E = `endTime − startTime`; TTFT = `completionStartTime − startTime`. | high 3-0 | If a customer feeds us gateway logs, never aggregate `response_time`. |
| 4 | Bedrock CloudWatch (`AWS/Bedrock`, dimension `ModelId`) publishes `InvocationLatency` (all ops) and `TimeToFirstToken` (streaming only); OTPS is metric math. No caller/project identity. | high 3-0 | Fleet-level cross-check only; per-project attribution needs the logs (ours) or the gateway. |
| 5 | Every Converse response carries `metrics.latencyMs`; with `trace: enabled`, Guardrails report `guardrailProcessingLatency` per assessment. AWS does not state whether `latencyMs` includes guardrail time. Guardrails do not evaluate tool-use payloads. | high 3-0 | Guardrails-hop overhead is observable **only** if the caller/gateway captures the response trace — not from invocation logs. |
| 6 | Invocation logging: off by default, one account+Region, `bedrock-runtime` only (not `bedrock-mantle`). *(The "no latency field" sub-claim is superseded by the live inspection above — the field exists for streaming calls.)* | medium→**settled** | Our source covers exactly this customer's shape; a mantle/OpenAI-compatible endpoint would be a blind spot. |
| 7 | Claude Code OTel: the 8 built-in **metrics** have no latency; the `claude_code.api_request` **event** carries `duration_ms` + `total_retry_duration_ms`; TTFT (`ttft_ms`) and task-level (`interaction.duration_ms`, `tool.execution.duration_ms`) exist only in **beta** trace spans. | high 3-0 | The client hop is the only one that sees developer-perceived latency incl. network/retries, and the only one with *task* duration — but it is beta and needs customer-side OTel export. |
| 8 | Bedrock `performanceConfig.latency: optimized` is preview, limited to Nova Pro / Claude 3.5 Haiku / Llama 3.1 in two Regions. For a Claude 4.x fleet every request is `standard`; `serviceTier` (priority/flex) is the relevant cost-vs-latency lever. Optimized-vs-standard price delta not confirmed. | medium 2-1 | Do not build a "latency-optimized" toggle; model cost-vs-latency on `serviceTier` if at all. |

### Refuted or unestablished (8 claims, 0-3 or 1-2)

- OTel spec does **not** define client-vs-server TTFT gap as the standard way to isolate gateway
  overhead — that is a reasonable technique, not a documented convention.
- Datadog does auto-capture TTFT for some integrations (claim that it is manual-only: refuted).
- Portkey analytics claims (mean-only, cache attribution): 1-2, treat as unknown.
- "CloudWatch `ModelId` is the only dimension": refuted 0-3, yet the verifier text still names
  `ModelId` as the supported dimension — leave per-project attribution to the logs/gateway regardless.
- **Angle 3 — latency → developer adoption/output: nothing survived.** No independent study, no
  threshold (TTFT perception limits) tied to coding assistants.
- **Angle 4 — enterprise evaluation frameworks covering cost + latency + feature parity: nothing
  survived.** "Feature parity" has no established definition in this context; the customer's own
  meaning must be elicited (Bedrock-vs-first-party API parity? model availability? tool-use support?).
- **Angle 5 — quantified Bedrock cost-vs-latency trade-off: nothing survived.**

## Critical-thinking pass on the decision

- **A1 (one customer = demand):** unsupported by any framework or survey found. Treat the request as
  a *benchmarking* need ("what do others measure") — which finding 1 answers precisely — plus a
  diagnostic need. Build the diagnostic; do not build a "latency KPI" that implies a target.
- **A2 (observable):** partially true, and better than expected: the Bedrock hop is fully observable
  from data we already hold, per project. Gateway and Guardrails hops need the customer's gateway.
  The client hop needs Claude Code OTel (beta for TTFT/task). State the boundary on the card.
- **A3 (matters for outcomes):** not established. This is the assumption most likely to be quietly
  smuggled into copy ("faster models → more output"). Refuse it explicitly.
- **A4 (one number):** false. Three numbers, as percentiles; TTFT only for streaming.
- **A5 (net positive):** yes at this scope — marginal cost is one parser change plus one rollup
  field; the risk is over-claiming, which copy controls.
- **Alternative explanation for the ask:** the perceived slowness may originate in the gateway or
  Guardrails, which our logs cannot see. If the Bedrock-hop p95 is healthy, the *honest* output is
  "the model hop is X ms; the rest is upstream of Bedrock and needs gateway telemetry" — a
  pointer, not a dashboard.

## Recommendation (medium confidence overall; high on the data path)

**Phase 1 — from existing logs, no new source (recommended now).**
Parse `amazon-bedrock-invocationMetrics` from the final chunk of streaming records in the ingestion
parser; carry `invocationLatencyMs` and `firstByteLatencyMs` into the PROJECT/PROJDAY rollups as
count + sum + a small histogram (fixed buckets) so p50/p95 are exact enough per project × model ×
day. Surface on the Projects page and the Cost page as **"Model-hop latency (Bedrock service time)"**
with p50 / p95 E2E and p50 / p95 time-to-first-byte, streaming coverage stated
("n of m calls were streaming; non-streaming calls carry no latency"). Athena template for the
same fields so Fast/Full agree. Copy: diagnostic; no productivity claim; names per OTel.

**Phase 2 — optional, customer-supplied.** Accept LiteLLM Prometheus/spend logs (E2E from
timestamps, never `response_time`) for gateway-hop decomposition and Guardrails overhead via the
Converse trace. Only if the customer runs the gateway and wants the per-hop view.

**Not recommended.** A latency KPI tile on the Overview implying a target; a "latency-optimized"
tier toggle (preview, not applicable to Claude 4.x); any claim linking latency to developer output.

**Open question for the customer, not for us to guess:** what they mean by "feature parity".

## What could not be established

Independent evidence that LLM latency changes developer adoption or output; any published
enterprise RFP/evaluation framework spanning cost + latency + feature parity; the optimized-vs-
standard price delta; whether Converse `latencyMs` includes Guardrails time.
