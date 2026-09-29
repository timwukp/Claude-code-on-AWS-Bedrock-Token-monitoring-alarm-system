# Spec: DORA tables top-N

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour (`frontend/src/pages/DoraPage.tsx` only)

### 1. `useTopN(rows, n = 10)` (local hook)
Returns `{ visible, hidden, button }`: `visible` is `rows` when `rows.length ≤ n` or after the reader asked for all,
else `rows.slice(0, n)`; `button` is a `.btn-sm` with `aria-expanded` reading "Show all N" / "Show top 10 of N", or
`null` when nothing is hidden. The hook does not sort.

### 2. Tables
| Panel | Ranking | Caption |
|---|---|---|
| Recent merged PRs | API order (newest first) | "N most recent merges in the last W days (the API returns up to 25), newest first · showing the newest 10" |
| All tracked repositories | `mergedPrs` desc | "N repositories, most merged PRs first — last W days, same definitions as above · showing the top 10" |
| Projects — delivery × cost | `estimatedUsd` desc | "N projects, highest estimated spend first — … last W days · showing the top 10" |

The "· showing …" suffix appears only when rows are hidden. Row content, columns, click-to-select on repositories,
the notes line and the cost footnote are unchanged.

### 3. Hooks placement
The three `useTopN` calls and the two `useMemo` rankings sit with the page's state declarations so they run on every
render regardless of which panels are shown (React hook order).

## Out of scope
Column sorting; API; charts; KPI cards; other pages.
