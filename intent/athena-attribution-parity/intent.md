# Intent: make the Full (Athena) project view attribute the traffic it can actually see

- **Slug:** athena-attribution-parity
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The Projects page offers two views of the same question — *which project spent this?* Fast reads
pre-aggregated DynamoDB rollups; Full runs Athena over the immutable raw invocation logs. On live
data they disagree almost totally:

| View | Rows | `untagged` |
|---|---|---|
| Fast (DynamoDB) | 20 projects | 17.54M tokens / $1,545.01 |
| Full (Athena) | 4 rows | 222.07M tokens / $13,857.95 — **99.97%** |

The UI told the reader this divergence was by design. **It is not, and the page overstated the
intentionality.** Reading the SQL settles it: the Athena path attributes from *one* source,
`COALESCE(m.project_name, requestMetadata['project_id'], 'untagged')` with a LEFT JOIN onto the
customer-supplied `project_mapping` CSV. The four-tier precedence this product documents —
**application inference profile tag ▷ `requestMetadata.project_id` ▷ admin identity hint ▷
untagged** — was implemented in the aggregator only, i.e. on the Fast path.

That omission is not a rounding error, because of how the strongest tier works. A project's calls
are *routed through* its application inference profile, so the invocation log records the **profile
ARN as `modelId`** and carries no `project_id` at all. Profile routing is the tier this product
recommends and can enforce with IAM — and it is precisely the tier Athena could not see. So the
better a tenant's attribution hygiene, the more of their spend the Full view dumped into
`untagged`. A project attributed entirely by profile routing was absent from the Full view
altogether, which is how the defect surfaced (qa F-1101, PR #43).

A second finding rode along: currency rendered without a thousands separator (`$13858.35`) on both
the Costs and Projects pages (qa F-1102).

## What is genuinely by design, and must stay so

Two of the four tiers cannot be reproduced from raw logs, and this chain must not pretend
otherwise:

- the **admin identity hint**, which claims a caller ARN for a single-project principal, exists
  only as registry state; and
- the **one-time historical attribution** that feature-13 applied to the *rollups*, deliberately
  leaving raw logs immutable.

Neither has any field in an invocation log. So after this change the Full view still reports a
larger `untagged` share than Fast, and the page must say which two tiers that residue is —
replacing the current blanket claim that the whole gap is intentional.

## Desired outcome

- The Full view resolves profile-routed traffic to its project, in the same precedence order the
  aggregator applies, so the two views agree on which tier wins.
- A project reads with the same name in both views. The strongest tier can only identify a project
  by id, and showing `agent-skills` in Full next to `Agent Skills Best Practice` in Fast is the
  same divergence in a different disguise.
- The page states exactly what Full cannot resolve and why, instead of implying the entire
  difference is intended.
- An unreadable profile cache degrades attribution to today's behaviour with a logged warning; it
  never fails the page.
- Currency reads as currency.

## Non-goals

- No new data store, export job or Glue table. The profile cache the aggregator already maintains
  is authoritative and self-healing; a mirror would add a staleness window and a second source of
  truth for the same fact.
- No change to any computed cost or token figure. This chain changes which bucket a row lands in,
  not what the row sums to.
- No attempt to synthesise the identity-hint or historical tiers into Athena. Refusing beats
  inventing, and the raw logs are deliberately immutable.

## Rider: the qa job that reported this could not report it

The `qa` run that found both findings exited non-zero from the bug-fix step, which under the
step's `bash -e` aborted the job **before** the workflow's own commenting, stall-detector and fuse
steps — the paths that carry the actionable message. That is why PR #43 carries a red check and no
comment explaining it. The tool treated "there is nothing here a patch can fix" as a tool failure.
Three defects in `ci-agent/bugfix_agent.py` ride with this chain, because they are what made a
correctly-refused finding look like a broken pipeline. Hardening them does **not** make that run
green: no diff-emitting bot could have fixed F-1101, since the fix was an attribution tier that did
not exist. Only this chain closes it.
