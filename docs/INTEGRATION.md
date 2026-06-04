# Integration — tagging your Bedrock calls (request-metadata)

How a customer application stamps `requestMetadata` onto every Bedrock call so this monitoring
system can attribute usage per **project** and **user**. This is **"Mapping A"** from
[ATTRIBUTION.md](./ATTRIBUTION.md) — it runs in **your** application code, at **call time**. The
monitoring system only ever *reads* these tags afterwards; it can never add them.

> If you have not read it yet, read the "who sets the tag, and when" section of
> [ATTRIBUTION.md](./ATTRIBUTION.md) first. The single non-bypassable prerequisite is that the
> caller supplies the tags on the call — there is no way to backfill them.

## The reusable wrapper

To make tagging consistent (and to keep PII out of long-lived logs), use the helper at
[`backend/lambdas/shared/request-metadata.ts`](../backend/lambdas/shared/request-metadata.ts). It
is dependency-light (no `@aws-sdk/client-bedrock-runtime` import required — it operates on a plain
input object) and pure, so you can copy it into your own app or import it directly.

It does two things:

1. **`buildRequestMetadata({ tenant, project_id, user_id, tags? })`** — validates and returns a
   clean `requestMetadata` map.
2. **`withRequestMetadata(request, { tenant, project_id, user_id, tags? })`** — returns a *new*
   request object with `requestMetadata` injected, ready to pass to `InvokeModelCommand` /
   `ConverseCommand`.

### Validation rules (what it enforces)

- **Required:** `tenant`, `project_id`, `user_id` must be non-empty strings — missing/empty throws
  `MetadataValidationError`.
- **No PII:** an email-like value (for any key, including `user_id`) is **rejected** — use an
  opaque id such as `u-2001`, not `alice@example.com`. These tags can sit in logs for years.
- **Safe characters / length:** keys must match Bedrock's allowed set; control characters and
  surrounding whitespace are stripped; values longer than 256 chars are truncated (with a warning);
  values over the recommended 64 chars warn but are kept.
- **Pair limit:** at most 16 key/value pairs (Bedrock's documented limit).

Anything unsafe is either fixed (and reported in `warnings`) or throws — keys are never silently
dropped.

## Usage

### TypeScript (AWS SDK v3)

```ts
import { InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { withRequestMetadata } from './shared/request-metadata';

const client = new BedrockRuntimeClient({});

// Your app already knows the current user and project from its auth/session and routing.
const { input, warnings } = withRequestMetadata(
  {
    modelId: 'anthropic.claude-opus-4-8',
    body: JSON.stringify({ /* ... */ }),
  },
  {
    tenant: 'acme',
    project_id: ctx.projectId, // e.g. "proj-bravo"
    user_id: ctx.userId,       // e.g. "u-2001" — opaque id, NOT an email
    tags: { env: 'prod' },     // optional
  },
);

if (warnings.length) console.warn('requestMetadata adjusted:', warnings);

await client.send(new InvokeModelCommand(input));
```

The same `withRequestMetadata(...)` call works for `ConverseCommand` input — both command inputs
carry an optional `requestMetadata?: Record<string, string>` field that this helper populates.

### Python (for reference)

The platform's helper is TypeScript, but the contract is identical in any SDK — build the map and
pass it as `requestMetadata`:

```python
bedrock_runtime.invoke_model(
    modelId="anthropic.claude-opus-4-8",
    body=...,
    requestMetadata={               # set BY THE APP, AT CALL TIME
        "tenant": "acme",
        "project_id": current_project,  # "proj-bravo"
        "user_id": current_user,        # "u-2001" — opaque, not an email
    },
)
```

## Can this be enforced with IAM? (Honest answer: no.)

A natural question is whether IAM can *require* that callers attach `requestMetadata` — the way
`aws:RequestTag` / `aws:TagKeys` condition keys let you require tags when creating tagged
resources.

**That mechanism does not exist for Bedrock `requestMetadata`.** `requestMetadata` is request-level
telemetry attached to a runtime inference call — it is **not** a resource tag, and there is **no
`aws:RequestTag`-style condition key** that an IAM policy (or SCP) can match against it. You cannot
write a `Deny` policy that fires when `requestMetadata` is absent or that constrains its values,
because the policy engine has nothing to evaluate. (Likewise there is no CloudFormation/CDK or
service-side setting that injects it.)

Concretely, this is **not** possible:

```jsonc
// THIS DOES NOT WORK — there is no condition key for Bedrock requestMetadata.
{
  "Effect": "Deny",
  "Action": "bedrock:InvokeModel",
  "Resource": "*",
  "Condition": { "Null": { "aws:RequestTag/project_id": "true" } }
}
```

What IAM *can* do is the coarse Layer-1 attribution that already works automatically: every
invocation log carries `identity.arn` (the calling principal), so you can always attribute by IAM
user/role and model without any tags. IAM just cannot reach inside the request to mandate the
finer `project_id` / `user_id` tags.

### So what is the practical control?

The **SDK wrapper is the enforcement point.** Make `withRequestMetadata(...)` (or an equivalent in
your stack) the *only* sanctioned way your application calls Bedrock, and you get consistent,
validated, PII-screened tags on every call. Recommended belt-and-braces measures:

- **Centralize Bedrock access** behind a small internal module/client that always calls the wrapper;
  forbid direct `InvokeModelCommand` construction elsewhere (lint rule / code review).
- **Fail closed in your app** if `buildRequestMetadata` throws — don't fall back to an untagged call.
- **Detect drift after the fact** in the monitor: rows where `requestMetadata['project_id']` is null
  show up as `untagged` in the By-Project view (see ATTRIBUTION.md Layer 3), so untagged traffic is
  visible and can be chased down operationally.

In short: tagging is a **client-side discipline**, not something AWS will enforce for you. The
wrapper plus a "no direct Bedrock calls" convention is the realistic way to guarantee it.
