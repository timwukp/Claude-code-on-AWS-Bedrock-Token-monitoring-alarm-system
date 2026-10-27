# Spec: Full-view freshness

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

1. `invocation-source.ts`: `day(alias)` — curated `l.dt`, raw `substr(l."timestamp", 1, 10)`.
2. `queries.ts byProject`: no `recentDays`; adds `MAX(MAX(<day>)) OVER () AS data_through` as the **last** select item so
   the five positional columns the page maps are unchanged. `topModels` / `hourlyUsage` keep their `dt` pruning.
3. `ProjectsPage.tsx`: state `fullThrough` from `rows[1].Data[5]`; "served from: athena · curated Parquet through <day>";
   cost-tile footer and panel caption rewritten (direction: Full lags; gap = tiers ③/④ + traffic since last ETL run);
   `fullVsFast` sentence appends "(curated data through <day>)"; Projects-tracked footer says "curated Parquet (refreshed daily)".
4. `help-content.ts project.source`: why/how rewritten; notes that Full never reads the raw delivery prefix.
5. Tests: `invocation-source.test.ts` (`day()`), `queries.test.ts` (all templates on curated; windowed templates prune;
   byProject all-time + `data_through` last).
