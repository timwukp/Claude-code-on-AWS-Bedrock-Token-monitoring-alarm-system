# Feature 46 — Mantle counts that do not vanish two weeks after the traffic stops

- **Chain:** `intent/mantle-counts-persisted/` · **Branch:** `feat/mantle-counts-persisted` off `main` after PR #79 · **PR:** #80
- **Origin:** qa on PR #77 (live dev, 2026-10-27): opus-5-5 "$1,115.68 not logged · Mantle —" on the Cost page; qa F-PR77-006
  (loading state rendered as an error).
- **Date:** 2026-10-27
- **Verdict:** PASS on gates and on a read-only dry run against live CloudWatch; live confirmation after the owner's Etl + Api
  deploy and one collector backfill (table below, to be filled).

## What this report has to say plainly
- **The number was never gone — the discovery was.** CloudWatch `ListMetrics` lists only metrics with datapoints in the past
  ~2 weeks. Opus 5.5's last Mantle datapoint was 2026-10-11; from ~10-25 it fell out of the list, so feature-40's reader
  never asked for it, while `GetMetricData` by name still returned **5,816** inferences. The fleet cross-check fired
  (`mantleInconsistent: true`) — as designed — but a footnote under a row reading "—" is not a warning anyone sees.
- **Fix: ask by name, and remember the names.** The daily collector now stores Mantle counts per model per UTC day
  (`MANTLE#DAILY`) and the fleet per day (`MANTLE#FLEET`), discovering models as *listed now ∪ stored before ∪ named by the
  bill*. The pages read the table and add a live tail only for days after the last stored day.
- **The flag moved onto the row.** When the block is inconsistent and a row has unlogged dollars with no count, the Mantle
  cell says "unresolved" with the reason; the note names the stored-through day.
- **Two riders on the same files:** the OpenAI 30-minute cache-write usage type now parses (`cacheWrite30m`, folded into the
  panel's cache-write column — it had been a bogus "model" with kind `other`); the all-time footer says "loading…" while
  `/v1/costs` is pending instead of "the costs endpoint did not respond" (F-PR77-006).

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 522/522 on the post-#79 tree (+6: discovery union + shape filter, fold, two 30m usage types) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — 11 stacks (Lakehouse added by #79) |
| `sdlc_ci_gate.py --require-active` | PASS — bound to the post-#79 main tip |
| Leak scan | clean |

## Dry run — live CloudWatch, read-only, 2026-10-01 → 10-27 (the window that read "—" on dev)
| Check | Result |
|---|---|
| `ListMetrics` Model values today | `openai.gpt-5.6-luna`, `openai.gpt-6-luna` only — opus-5-5 and gpt-6-sol absent |
| `mantleModelsToQuery(listed, [], bill models)` | adds `anthropic.claude-opus-5-5`, `openai.gpt-6-sol` from the bill lines; rejects the un-parsed 30m usage type name |
| `fetchMantleDaily` by name | **opus-5-5 5,816**, gpt-6-luna 231, gpt-5.6-luna 208, gpt-6-sol 1 — 12 day-model rows over 9 days |
| per-model sum vs fleet | 6,256 == 6,256 — **CONSISTENT** (deployed code: 440 vs 6,256, inconsistent) |

## Live — after the owner's deploys (to fill)
| Check | Result |
|---|---|
| Etl `cdk diff` | adds `cloudwatch:GetMetricData` + `ListMetrics` on `BillCollectorFn` (IAM) |
| Collector backfill `{start: 2026-10-01, end: <today>}` | TBD |
| `/v1/overview?window=mtd` opus-5-5 row | TBD — expect `mantle.inferences` 5,816, no `mantleInconsistent`, `mantleStoredThrough` = yesterday |
| `/v1/latency?window=30` Mantle block | TBD — expect opus-5-5 listed again |

## Known limits
- The live tail (days after the last stored day) still discovers via `ListMetrics` — correct for recent days by
  definition. Metric Streams → bronze (P1) will replace the live read altogether.
- Mantle tokens remain unpriced (no cache split).
