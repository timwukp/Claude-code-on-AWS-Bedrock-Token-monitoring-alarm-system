# Spec: resolve inference-profile ids to model names, and mark what was resolved

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `GET /v1/latency?window=1|7|30` — three new optional fields per model row

`LatencyRow` gains:

| Field | Meaning |
|---|---|
| `via?: 'inference-profile'` | `modelId` was an application inference profile id, not a model id |
| `profileName?: string` | the profile's own name, when it has one |
| `resolvedModel?: string` | the foundation model behind the profile — **absent** when the profile routes to several |

`modelId` keeps holding **exactly** what CloudWatch's dimension held. It is not rewritten, so the
raw series is always recoverable from the response.

All three fields are optional and absent for a direct model row, so the response stays
backward-compatible with the shape #52 shipped.

### 2. `resolveLabel(modelId, profiles)` — the decision, as a pure function

| Case | `label` | `via` | `resolvedModel` |
|---|---|---|---|
| not a profile id | `modelId` minus any `us.`/`eu.`/`apac.`/`global.` prefix | absent | absent |
| profile → exactly one distinct model | that model, prefix stripped | set | set |
| profile → several distinct models | the profile's name, else its id | set | **absent** |
| profile id not in the map | `modelId` verbatim | absent | absent |

A profile listing the same model once per region counts as **one** distinct model, since that is one
model reached over several routes.

### 3. The list call is best-effort, by requirement

`bedrock:ListInferenceProfiles` is paginated to exhaustion, and **any** failure — denial, throttle,
transport — degrades to an empty map rather than propagating. The endpoint then returns raw ids, as
it did before this change, and every other field is unaffected.

A labelling aid must not be able to take a metrics endpoint down. This is the one place where
swallowing an error is the specified behaviour rather than sloppiness.

### 4. Page

- The table cell shows the resolved name plus a badge: **`via profile`** when a model was resolved,
  **`multi-model profile`** when one deliberately was not. The badge's `title` names the profile id
  and either the resolved model or the reason no model is claimed.
- Rows that now share a label (the same model reached directly **and** through a profile is the
  common case) are disambiguated by their route: the profile name for profile rows, the region
  prefix for direct rows. This replaces the previous disambiguator, which reported a profile row as
  `direct` — wrong, and wrong in a way that hid the profile.
- The model picker uses the same disambiguator, clipped to 16 characters with the full value in
  `title`, because profile names are chosen by whoever deployed them and can be long.

### 5. Not in scope

No new scope, no project dimension, no change to the hop model, no change to any percentile or to
the `approximated` / `derived` flags. `MAX_MODELS` stays 12.

## Acceptance

- The three ids qa flagged on the dev account render as model names.
- A multi-model profile renders the profile name and **no** model claim, asserted by a unit test.
- An unknown id renders verbatim, asserted by a unit test.
- Denying the list call leaves the endpoint returning 200 with raw ids.
