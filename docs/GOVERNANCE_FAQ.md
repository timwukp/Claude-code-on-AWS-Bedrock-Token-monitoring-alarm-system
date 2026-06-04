# Cost Governance FAQ — Amazon Bedrock token usage

Practical answers to three questions teams ask when adopting Amazon Bedrock (including Claude
models) and wanting predictable, defensible costs from day one: **observability**, **controls**,
and **operating practices**. This maps directly to what this platform provides, and is honest
about where Bedrock's native capabilities differ from consumer Claude offerings.

---

## 1. Observability — proactively tracking and alerting on token usage / cost

**Short answer:** AWS Budgets and CloudWatch Metrics are both correct, but the strongest setup
for Bedrock is a *layered* one. Use all of these together:

| Layer | Mechanism | Why it's good for Bedrock |
|---|---|---|
| Real-time metrics | **CloudWatch** — `AWS/Bedrock` namespace: `InputTokenCount`, `OutputTokenCount`, `Invocations` (+ `InvocationLatency`, throttles, errors) | Second-level granularity; set static-threshold alarms → SNS. |
| Cost anomaly detection | **AWS Cost Anomaly Detection** | **ML learns your baseline automatically** — no thresholds to guess. Free feature. Adapts as usage grows, so you don't re-tune when a pilot scales. |
| Budget alerts | **AWS Budgets** (ACTUAL **and** FORECASTED) | Forecasted alerts warn you *before* you hit the limit, not after. |
| Deep analytics | **Bedrock Model Invocation Logging → S3 → Athena** | Per-invocation token counts, model, and caller IAM ARN — query "who / which project consumed what". |
| Dashboard | This platform's Usage / Cost views | Hourly token curve, per-model spend, anomaly feed in one place. |

**Better-than-the-obvious points:**

- **Cost Anomaly Detection (ML)** is the single best Bedrock-specific addition. Because it
  auto-learns the baseline, scaling from a small pilot to a large rollout doesn't require
  constantly resetting thresholds.
- **Forecasted budget alerts** catch trajectory, not just breaches.
- The **Athena layer** answers the inevitable "who/which project drove the cost?" question.
  Bedrock invocation logs include the caller `identity.arn`, enabling per-IAM-principal
  attribution; richer per-user/per-project attribution comes from request metadata tags
  (see [`ATTRIBUTION.md`](./ATTRIBUTION.md)).

> **Prompt caching changes the cost story.** Coding-agent workloads on Claude reuse large
> contexts, generating very high **cache-read** token counts — and cache reads bill at **0.1×**
> the base input rate. Reporting raw total tokens overstates cost; always break out cache-read
> separately. This platform's Cost view does this, so actual spend is far lower than the
> headline token volume suggests. This is often the most important data point when reassuring
> stakeholders that the tool is not "expensive."

---

## 2. Controls — preventing cost spikes

> **Important — set expectations precisely (this is widely misunderstood):** Bedrock **does**
> have auto-resetting token quotas, but they are **throttling/rate limits, not a cost cap**.
> Per the [Bedrock quotas docs](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-runtime.html),
> the `bedrock-runtime` endpoint enforces per-model **tokens-per-minute (TPM)** and a **maximum
> tokens-per-day** quota (RPM is no longer enforced). These reset on their window (per-minute /
> per-day) — but they exist to protect the service, default high (per-day ≈ per-minute × 1440),
> are adjustable on request, and **you are billed for all usage under them**. So they are *not*
> a like-for-like equivalent of consumer Claude's "ration access until it resets" allowance,
> which blocks you to cap usage. For genuine **cost** control, use the enterprise mechanism below.

| Control | Mechanism | What it actually does |
|---|---|---|
| Soft alerts | CloudWatch Alarm + SNS | Notify only — doesn't block. |
| **Hard cost cap** | **AWS Budgets Actions** → auto-apply a restrictive IAM policy or SCP at a $ threshold | **Hard stop on spend** — freezes access when the cost cap is hit. The right tool for cost control. |
| Rate / throttle ceiling | **Bedrock token quotas** (per-model TPM + max-tokens-per-day) via Service Quotas | Returns HTTP 429 `ThrottlingException` on breach. Protects throughput; **not** a billing cap. |
| Automated response | **EventBridge + Lambda** | Detect anomalous/denied activity → notify or contain. |
| Model tiering | Route cheap tasks to Haiku, reserve Opus for hard ones | Controls cost at the source. |

**The closest thing to an automatic cost brake = AWS Budgets Action.** AWS Budgets can run an
action automatically when a cost/usage threshold is reached, and the available actions include
**applying an IAM policy or a service control policy (SCP)** — a genuine hard stop, scopable per
account or per cost-allocation tag
([AWS Budgets actions docs](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html)).

**What to tell stakeholders:** Bedrock has token quotas that reset per minute/day, but those are
rate limits — you still pay for everything under them. The enterprise *cost* brake is a Budget
Action that freezes access at a spend cap, complemented by the token quotas (throughput
protection) and automated event-driven response.

---

## 3. Operating practices — keeping costs predictable from the start

### Day-1 (do these before the first real usage)

1. **Enable Model Invocation Logging immediately.** It's off by default; turn it on day one or
   you have no history to analyse later.
2. **Require `requestMetadata` tagging** (`project_id`, `user_id`) on every Bedrock call. This
   is the *only* way to attribute usage to a project/user, and it cannot be added retroactively
   — see [`ATTRIBUTION.md`](./ATTRIBUTION.md).
3. **Create a Cost Anomaly Detection monitor + an AWS Budget** (a few minutes; the ML then
   watches the baseline for you).
4. **Set per-team / per-project budgets** using cost-allocation tags, rather than one shared
   pool — so one team's spike doesn't silently consume everyone's headroom.

### Ongoing

5. **Tier models by task.** Default to Haiku/Sonnet; reserve Opus for genuinely hard work.
6. **Exploit prompt caching and report it correctly.** Claude coding agents cache automatically;
   present cache-read tokens separately (0.1× rate) so reported cost reflects reality.
7. **Quarterly forensic review** via Athena — identify top consumers and discuss outliers early.
8. **Start with showback, not chargeback.** Give each team visibility into its own usage (the
   By-Project view) to build cost awareness before introducing cross-charging.

---

## Honest limitations (set expectations correctly)

1. **Bedrock's token quotas are rate limits, not a cost cap.** Bedrock *does* auto-reset token
   quotas (per-minute TPM and a max-tokens-per-day), but they exist to throttle throughput
   (HTTP 429), default high, and don't stop billing — they are not the consumer-Claude
   "ration until it resets" cap. For cost control use **Budget Actions** (hard $-stop); use the
   token quotas for throughput protection.
2. **Per-project enforcement is observe-and-alert today, not real-time blocking.** You can see
   and alert on per-project usage now; *instantly blocking a single project at $X* requires
   additional work (per-tag budget action or a custom enforcement Lambda). This is on the
   roadmap, noted in [`ATTRIBUTION.md`](./ATTRIBUTION.md).

---

## One-paragraph summary

This platform makes Bedrock (including Claude) costs **visible, attributable, and capped from
day one**. Observability is layered — CloudWatch metrics, ML-based Cost Anomaly Detection, and
forecasted Budgets. Controls include a hard-stop Budget Action and per-model rate limits.
Operating practices center on logging, request-metadata tagging, model tiering, and surfacing
prompt-cache savings — so cost is predictable and the case to scale rests on real data rather
than a vague "is this expensive?" worry.
