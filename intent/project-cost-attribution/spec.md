# Spec: project cost attribution × DORA join (feature-13)

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

1. **Attribution precedence** per invocation-log record: application-inference-profile hit
   (resolved via the profile's `project` tag; also rewrites the model id to the real underlying
   model so rate cards match) → `requestMetadata.project_id` → admin identity hint
   (case-insensitive caller-ARN match) → `untagged`.
2. **Profiles**: the `Tums-<env>-Projects` stack creates one tagged application inference
   profile per configured project × model (wrapping the us.* cross-region profiles). The
   aggregator resolves unseen profile ARNs at runtime (GetInferenceProfile +
   ListTagsForResource), caches resolutions in the registry, and negative-caches untagged
   profiles for 24h so a later tag fix self-heals.
3. **Daily rollups**: new `TENANT#<t>#PROJDAY` items (`<day>#<projectId>#<modelId>`) written by
   the aggregator; a one-off backfill script fills history from S3 without touching any
   existing key space (complete days SET idempotently; the single watermark-boundary day is
   ADD guarded by a conditional marker).
4. **Registry** (previously-unused tums-tenants table): projects
   {id, name, costCenter, repos[], identityArns[]} + profile cache + seed-once marker;
   `GET/POST /v1/projects/registry`, `DELETE /v1/projects/registry/{id}` (writes admin-only).
5. **Join**: `GET /v1/dora/projects?window=` pools each project's repos' PRs/issues through the
   same computeDora used everywhere, prices PROJDAY rows per model, and derives
   $/deployment = $/merged PR. Rendered as a DORA-page panel synced to the window picker;
   By-Project page shows registry names/cost centers, gains per-model pricing on the fast path
   (replacing flat-rate scaling), and hosts the admin registry panel.
6. **Enforcement (opt-in, default off)**: managed policy allowing InvokeModel* only on
   project-tagged profile ARNs plus foundation models reached through a profile
   (`bedrock:InferenceProfileArn` condition); pilot role for live deny/allow validation.
7. **Pilot**: `.claude/settings.json.example` documents routing a clone's Claude Code sessions
   through the project profiles (real ARNs embed the account id, so the filled file stays
   local in this public repo; private enterprise repos commit it).

## Non-goals

Per-request billing-grade dollars (CE/CUR is usage-type/day grain — documented); bedrock-mantle
traffic (invocation logging does not capture it); per-developer profiles (identity covers the
user dimension; profile quota is per-project only).

## Evals / verification

Pure-module Jest: attribution precedence and effective-model rewrite, day bucketing +
cross-file de-dup, pooled Delivery×Cost row assembly (per-model pricing, notes, $/PR),
registry validation/seeding, and the rate-card guard proving opaque application-profile ARNs
price to zero unless resolved at ingest. Live: deploy, seed, aggregator resolution, backfill,
`/v1/dora/projects` with real data, IAM pilot matrix — recorded in
docs/test-reports/feature-13-project-cost-attribution.md.

## Addendum (owner-directed, 2026-09-17, post-acceptance)

Two facts recorded after live deployment, both within the accepted file set:

1. The attribution tag key is **`tums-project`**, not `project`: the app-wide billing tag
   (`project=token-usage-monitoring`, applied by the CDK app aspect) overrides same-key
   resource tags — observed live and fixed before the IAM matrix was validated.
2. The owner directed a **one-time historical attribution** of pre-AIP untagged usage via
   commit-time correlation (`HOUR_PROJECT_MAP` mode of the backfill script; precedence
   unchanged; `SYSTEM#RETRO` marker prevents repetition). Go-forward attribution runs solely
   on the strict AIP mechanism specified above.
