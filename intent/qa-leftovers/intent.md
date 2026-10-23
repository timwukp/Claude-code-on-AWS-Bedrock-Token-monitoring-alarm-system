# Intent: the three qa findings no chain owned

- **Slug:** qa-leftovers
- **Author:** Claude (AI agent)
- **Date:** 2026-10-11
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Three qa findings have been red on every PR since #68/#69 because they sat on pages outside each chain's plan:

- **F-PR69-003 `/dora`** — the "Lead time per week" Y-axis reads `25h, 2d, 3d, 4d`: Recharts picks "nice" ticks in the
  data's unit (hours), and a per-tick formatter switches unit at 48 h, so the first tick is in hours and odd.
- **F-PR69-007 `/usage`** — the token chart's x-axis is a category axis drawn from the hours/days that had traffic, so
  a quiet weekend vanishes and tick spacing stops meaning time.
- **F-PR68-004 `/v1/quotas`** — 6–11 s per request (CloudWatch REPORT lines, 10-08 → 10-10): the handler summed tokens
  one model at a time, ~0.5 s a model, and paged the bedrock service's several hundred quotas on every call.

## Desired outcome

- Lead-time axis ticks sit on whole-day multiples when the series reaches two days (and whole hours below), every
  label in one unit.
- The Usage series is zero-filled for every hour/day in the window, so the axis is linear in time; the table shows
  the quiet buckets as zeros.
- `/v1/quotas` sums all models in one round of parallel calls and keeps the quota list warm for ten minutes.

## Non-goals
No change to what is measured or priced; no new data source; the F-PR69-008 private-repo finding is an operations
item for the owner (collector token), not code.
