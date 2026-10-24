# Feature 43 — Lakehouse P0: curated table for the Full view, working ETL, failure alarm

- **Chain:** `intent/lakehouse-p0-stabilise/` · **Branch:** `feat/lakehouse-p0-stabilise` off `main@e08ae19` (#74) · **PR:** #76
- **Origin:** plan `floating-enchanting-kahan` (lakehouse programme, approved 2026-10-24), chain 1 of 4. Triggered by qa
  F-PR75-001 and the root-cause work in `docs/incidents/2026-10-athena-body-collision.md`.
- **Date:** 2026-10-24
- **Verdict:** PASS on all gates; deploy + live verification pending the owner's authorisation (Data, Etl, Api, Automation).

## What this report has to say plainly
- **Tests were written before the fixes** and were red first: the infra harness did not exist (`infra/test` is new), the
  ETL had no incremental logic, and the SQL builders spelled every column by hand. Each is now pinned.
- **The ETL fix is one option and one property** (`platform: LINUX_AMD64`, `runtimePlatform` X86_64) — three months of
  silent failure for a platform mismatch, which is why the alarm ships in the same change.
- **The Full view's semantics did not move.** Attribution tiers, rate CASEs, route factor and grouping are untouched; only
  the table and the column spellings come from `invocation-source.ts`. The 2026-10-23 bodies become irrelevant to the app.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/invocation-source.ts` (+test) | table/column adapter: `CURATED_SOURCE` default, `RAW_SOURCE` break-glass; `meta()` key guard; `tenantPredicate`; `recentDays` dt pruning |
| `backend/lambdas/api/projects.ts`, `queries.ts` (+tests) | all templates read through the adapter; `dt` pruning on the windowed templates |
| `backend/analysis/etl.py` (+test) | `plan_days`/`day_prefix`/watermark (incremental), tolerant `flatten_record`, 16-thread reads, `CURATED_COLUMNS` dtypes |
| `infra/lib/stacks/data-stack.ts` | `bedrock_invocations_curated` Glue table, Parquet, `dt` projection `2026-06-01,NOW` |
| `infra/lib/stacks/etl-stack.ts`, `infra/bin/infra.ts` | image platform, runtime platform, `EtlFailedAlarm` → `AutomationStack.alertTopic` |
| `infra/lib/stacks/api-stack.ts` | `INVOCATION_SOURCE=curated` |
| `infra/jest.config.js`, `infra/test/*` | harness + 6 assertions |
| `.github/workflows/ci.yml`, `AGENTS.md`, `.gitignore` | infra tests + ETL unittest in CI; six gates; ignore tsc output |

## Gates
| Gate | Result |
|---|---|
| backend `jest` | 422 / 422 (32 suites; +7 adapter, +4 source-switch) |
| backend `tsc --noEmit` | PASS |
| infra `jest` | 6 / 6 |
| infra `tsc --noEmit` / `npm run build` | PASS |
| `python3 -m unittest test_etl` | 23 / 23 |
| frontend `vite build` | PASS (no frontend change) |
| `cdk synth --context env=ci` (all 10 stacks) | PASS |
| `cdk diff --context env=dev` (Data, Etl, Api) | Data `+AWS::Glue::Table`; Api `INVOCATION_SOURCE` on 12 Lambdas; Etl `+Alarm`, task definition replaced (RuntimePlatform), new image; Automation `+Output` (topic export) |
| SDLC gate | PASS |

## Live (after the owner's deploy) — to fill
- Start `EtlStateMachine` once → SUCCEEDED; `s3://<curated>/usage/dt=*/part-0000.parquet` present for every day since 2026-06-03; watermark written.
- `/projects` Full view returns rows (no "Athena query failed"); `/v1/queries` byProject/topModels/hourlyUsage return.
- Forced failure (`ETL_MODE=full`, bad `RAW_LOG_BUCKET`) → alarm e-mail within the hour.

## After this chain
P1 `lakehouse-p1-bronze` (S3 Tables, Firehose from the CloudWatch Logs destination, Metric Streams, CUR 2.0, zero-ETL,
OTel ingress). PR #75's UI work is carried into P3.
