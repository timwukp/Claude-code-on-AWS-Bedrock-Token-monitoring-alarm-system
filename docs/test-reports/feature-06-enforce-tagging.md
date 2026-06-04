# Test Report — Feature #6: Enforce request-metadata tagging

| | |
|---|---|
| Issue | #6 |
| Branch | `feat/enforce-tagging` |
| Date | 2026-06-04 |
| Environment | Local (no AWS deploy needed — client-side helper) |
| Result | **PASS** — unit tests |

## Scope

Provide a reusable helper so the calling application sets `requestMetadata`
(`{tenant, project_id, user_id}`) consistently and safely on Bedrock calls — the prerequisite
for per-project/per-user attribution. Includes PII screening and an honest IAM caveat.

## Deliverables

- `backend/lambdas/shared/request-metadata.ts`:
  - `buildRequestMetadata(...)` → validated `{metadata, warnings}`: enforces required fields,
    Bedrock-safe key charset, 256-char hard cap (truncate+warn), 64-char soft cap (warn),
    16-pair limit, control-char stripping, duplicate-key rejection, non-string rejection, and
    **email-like PII rejection** for `user_id` / tag values.
  - `withRequestMetadata(request, metadata)` → returns a NEW request object with `requestMetadata`
    injected (no mutation); merges with existing tags.
- `backend/lambdas/shared/request-metadata.test.ts` — 21 Jest tests.
- `docs/INTEGRATION.md` (new) — customer copy-paste usage (TS + Python) and the IAM-enforceability note.
- `docs/ATTRIBUTION.md` — Layer 2 references the wrapper.

## Unit tests

`cd backend && npx jest request-metadata` → **21 passed / 21**. `npx tsc --noEmit` → PASS.
Cases: valid builds; missing/empty required fields; email PII rejection (user_id and tags);
control-char stripping; truncation + soft-cap warnings; bad key chars; non-string values;
pair-count overflow; wrapper injection / no-mutation / override behavior / error propagation.

## Honest caveat (documented in INTEGRATION.md)

There is **no `aws:RequestTag`-style IAM condition key for Bedrock `requestMetadata`** — it is
request-level inference telemetry, not a resource tag. IAM/SCP **cannot** mandate or constrain
these tags. The practical enforcement is the SDK wrapper plus a "no direct Bedrock calls"
convention; untagged traffic still appears as `untagged` in the By-Project view. The doc shows
the non-working Deny-policy example explicitly labeled as unsupported so it isn't mistaken for a
real control.

## Verdict

Unit tests green; no deploy required (client-side helper). Ready for review.
