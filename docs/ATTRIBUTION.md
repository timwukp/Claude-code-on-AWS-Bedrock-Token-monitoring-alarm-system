# Usage Attribution — by User and by Project

How the platform attributes Bedrock token usage to **users**, **projects**, and **cost
centers** for showback / chargeback. Three layers, in increasing specificity.

---

## ⚠️ Key concept: who sets the tag, and when (read this first)

A common misunderstanding: people assume the **monitoring system** attaches `project_id` /
`user_id` to each record. It does **not** — and cannot. The distinction matters when explaining
this to a customer.

- `requestMetadata` is written **into the Bedrock API request itself**, by the **customer's
  application**, at the **moment the call is made**. Once Bedrock has logged it, the tag is
  frozen in the log.
- The monitoring system is a **read-after-the-fact** consumer: it reads whatever tags were
  already on the log. It can never go back and inject a tag that wasn't sent.

Analogy: `requestMetadata` is a label the sender sticks on the parcel before posting it. The
post office (Bedrock) records only what was stuck on. The monitoring system is someone reading
the delivery records later — it can read the label, but cannot travel back to add one.

**Two different mappings — don't conflate them:**

| | Where it happens | Who owns it | Example |
|---|---|---|---|
| **Mapping A** — decide which ids to tag on *this* call | inside the customer app, at call time | the customer's own code | "the logged-in user is `u-2001`, working in `proj-bravo` → put both in `requestMetadata`" |
| **Mapping B** — translate `project_id` → project name / cost center | at query time, after the fact | this monitoring system | `proj-bravo` → "Fraud Detection" / CC-2002 (the CSV in Layer 3) |

Mapping A is the customer application's responsibility (it already knows the current user and
project). The monitoring system neither sees nor controls it. Mapping B (Layer 3 below) is the
only mapping this system owns.

**One-line summary:** the values in `requestMetadata={project_id, user_id}` are arbitrary
customer-defined codes — but they must be set **by the customer's app, at call time**, not
added later by the monitor. The monitor only *reads* those tags and *translates* `project_id`
into a human-readable project via the CSV.

---

## Layer 1 — IAM identity (automatic, zero effort)

Every Bedrock invocation log carries `identity.arn` — the IAM principal that made the call
(verified on real logs; see `VERIFICATION.md`). This gives per-IAM-user/role attribution with
no application changes. The dashboard's tenant scoping already uses this.

```sql
SELECT identity.arn, SUM(input.inputTokenCount + output.outputTokenCount) AS tokens
FROM bedrock_invocation_logs GROUP BY identity.arn
```

## Layer 2 — request metadata tags (per-call, application-set)

For finer attribution (a logical `user_id`, `project_id`, `team`, etc. that doesn't map 1:1 to
an IAM principal), the calling application must pass `requestMetadata` on each Bedrock call.
These tags are written verbatim into the log's `requestMetadata` map.

Integration the customer adds to **their** application (this is "Mapping A" — it runs in their
code, at call time):

```python
# Customer application code (NOT the monitoring system).
# The app already knows who is logged in and what project they're working in.
current_user = ctx.user_id          # e.g. "u-2001"   — from the app's auth/session
current_project = ctx.project_id    # e.g. "proj-bravo" — from the app's routing/context

bedrock_runtime.invoke_model(
    modelId="...",
    body=...,
    requestMetadata={                 # ← set BY THE APP, AT CALL TIME
        "project_id": current_project,
        "user_id": current_user,
        "tenant": "<tenant-key>",
    },
)
```

> This is the one prerequisite that cannot be bypassed: Bedrock only logs the metadata the
> caller supplies, at the time of the call. The monitoring system cannot add it afterwards.
> Without it, usage can still be grouped by IAM identity (`identity.arn`) and model — but not by
> the customer's own user_id / project_id.

**Constraints to share with integrators:** `requestMetadata` keys/values are strings; keep them
short, stable codes (resolve names later via the CSV). Avoid putting PII in the tags (use
`u-2001`, not an email) — the tags land in logs that may be retained for years.

## Layer 3 — project mapping (CSV → human-readable rollup)

`project_id` is usually an opaque code. To roll up to a project name and cost center, the
customer supplies a mapping CSV uploaded to S3 (curated bucket, `mappings/` prefix):

```csv
proj-alpha,Customer Portal,CC-1001
proj-bravo,Fraud Detection,CC-2002
proj-charlie,Internal Copilot,CC-3003
```

An Athena external table (`project_mapping`) is created over it, and the `/v1/projects`
endpoint joins logs to it:

```sql
SELECT
  COALESCE(m.project_name, l.requestMetadata['project_id'], 'untagged') AS project,
  m.cost_center,
  COUNT(DISTINCT l.requestMetadata['user_id'])               AS users,
  SUM(l.input.inputTokenCount + l.output.outputTokenCount)   AS tokens,
  SUM(l.input.inputTokenCount)*<in_rate>
    + SUM(l.output.outputTokenCount)*<out_rate>
    + SUM(COALESCE(l.input.cacheReadInputTokenCount,0))*<cache_rate> AS est_usd
FROM bedrock_invocation_logs l
LEFT JOIN project_mapping m ON l.requestMetadata['project_id'] = m.project_id
WHERE COALESCE(l.requestMetadata['tenant'], l.identity.arn) = '<tenant>'
  AND l.requestMetadata['project_id'] IS NOT NULL
GROUP BY 1, 2 ORDER BY tokens DESC
```

The join key is `requestMetadata['project_id'] = project_mapping.project_id`. `LEFT JOIN` keeps
unmapped projects visible (shown as their raw id / `untagged`). `COUNT(DISTINCT user_id)` yields
the user count per project.

## Attribution map

```
 user_id  (u-2001) ─┐
                    ├── set per call in requestMetadata → written to each log record
 project_id(proj-bravo)─┘                    │
                                             │  JOIN on project_id
 project_mapping.csv ────────────────────────┘
   proj-bravo → "Fraud Detection" / CC-2002
                                             ↓
   By-Project view:  Fraud Detection | CC-2002 | 2 users | 415K tokens | $11.63
```

## Demo data note

The live demo's "By Project" page is populated with **synthetic** project-tagged records
(proj-alpha/bravo/charlie + the mapping CSV above), because the account's real traffic (Claude
Code sessions) is not tagged with requestMetadata. The query path, JOIN, and rollup are real and
run through Athena; only the project-tagged input rows are seeded for illustration. Real
customers enable this by tagging their Bedrock calls (Layer 2) and uploading their mapping CSV
(Layer 3).

## Productionizing (TODO)

- Pre-aggregate per-project usage in the scheduled aggregator (write `TENANT#x#PROJECT` items)
  so the By-Project page reads DynamoDB instead of running Athena per request.
- Provide an upload UI / S3 event to refresh `project_mapping` when the CSV changes.
- Add per-project budgets + anomaly monitors (Cost Anomaly Detection cost-allocation-tag mode).
